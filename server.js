require('dotenv').config();
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');

// Configuration
const BASE_URL = 'https://prehraj.to';
const TMDB_API_KEY = process.env.TMDB_KEY;

if (!TMDB_API_KEY) {
  console.error('Chyba: TMDB_KEY není definován v .env nebo v prostředí');
  process.exit(1); // Exit to prevent hanging
}

// Define the addon
const builder = new addonBuilder({
  id: 'org.stremio.prehrajto',
  version: '1.0.5',
  name: 'Přehraj.to',
  description: 'Streamy z prehraj.to',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  logo: 'https://stremio.com/website/stremio-logo.png',
  behaviorHints: { adult: false },
});

// Function to normalize string (mimic Kodi's encode)
function normalizeString(str) {
  const diacriticsMap = {
    'á': 'a', 'č': 'c', 'ď': 'd', 'é': 'e', 'ě': 'e', 'í': 'i', 'ň': 'n', 'ó': 'o',
    'ř': 'r', 'š': 's', 'ť': 't', 'ú': 'u', 'ů': 'u', 'ý': 'y', 'ž': 'z',
    'Á': 'A', 'Č': 'C', 'Ď': 'D', 'É': 'E', 'Ě': 'E', 'Í': 'I', 'Ň': 'N', 'Ó': 'O',
    'Ř': 'R', 'Š': 'S', 'Ť': 'T', 'Ú': 'U', 'Ů': 'U', 'Ý': 'Y', 'Ž': 'Z'
  };
  return str.replace(/[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/g, match => diacriticsMap[match] || match);
}

// Function to get title from TMDB using IMDb ID
async function getTitleFromTMDB(imdbId) {
  try {
    const cleanImdbId = imdbId.split(':')[0];
    if (!cleanImdbId.startsWith('tt') || !/tt\d{7,8}/.test(cleanImdbId)) {
      throw new Error('Neplatný formát IMDb ID');
    }

    let title;
    let response = await axios.get(
      `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id&language=cs-CZ`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      }
    );
    title = response.data.movie_results[0]?.title || response.data.tv_results[0]?.name;

    if (!title) {
      response = await axios.get(
        `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id&language=en-US`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        }
      );
      title = response.data.movie_results[0]?.title || response.data.tv_results[0]?.name;
    }

    if (!title) {
      throw new Error(`Nenalezen název pro IMDb ID: ${cleanImdbId}`);
    }
    console.log(`TMDB dotaz pro ${cleanImdbId}: ${title}`);
    return title;
  } catch (err) {
    console.error(`TMDB API chyba pro ${imdbId}: ${err.message}`);
    throw err;
  }
}

// Function to extract direct stream URL and subtitles from prehraj.to video page
async function getStreamUrl(videoPageUrl) {
  try {
    console.log(`Načítám stránku videa: ${videoPageUrl}`);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Prevent rate limiting
    const response = await axios.get(videoPageUrl, {
      headers: {
        'User-Agent': 'kodi/prehraj.to',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;cs;q=0.5',
        'Referer': BASE_URL,
      },
    });
    const $ = cheerio.load(response.data);

    let streamUrl = null;
    let subtitles = null;

    // Try to extract stream URL from var sources (Kodi approach)
    const sourcesScript = $('script')
      .filter((i, el) => $(el).html().includes('var sources = ['))
      .html();
    if (sourcesScript) {
      const sourcesMatch = sourcesScript.match(/var sources = \[(.*?)\];/s);
      if (sourcesMatch) {
        const sources = sourcesMatch[1];
        const fileMatch = sources.match(/file: "(.*?)"/) || sources.match(/src: "(.*?)"/);
        if (fileMatch) {
          streamUrl = fileMatch[1];
          console.log(`Nalezen stream URL: ${streamUrl}`);
        } else {
          console.error(`Nenalezen file/src v sources na ${videoPageUrl}`);
        }
      } else {
        console.error(`Nenalezeno pole sources na ${videoPageUrl}`);
      }
    } else {
      console.error(`Nenalezen script s var sources na ${videoPageUrl}`);
    }

    // Fallback: Check for video tags or player links
    if (!streamUrl) {
      const videoSource = $('video source').attr('src') || $('#video-wrap video').attr('src');
      if (videoSource) {
        streamUrl = videoSource.startsWith('http') ? videoSource : `${BASE_URL}${videoSource}`;
        console.log(`Nalezen stream z video tagu: ${streamUrl}`);
      } else {
        const playerLinks = [];
        $('div.tabs__control-players a').each((i, el) => {
          const href = $(el).attr('href');
          if (href) {
            playerLinks.push(href.startsWith('http') ? href : `${BASE_URL}${href}`);
          }
        });

        for (const playerUrl of playerLinks) {
          console.log(`Zkouším player URL: ${playerUrl}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          const playerResponse = await axios.get(playerUrl, {
            headers: {
              'User-Agent': 'kodi/prehraj.to',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;cs;q=0.5',
              'Referer': videoPageUrl,
            },
          });
          const player$ = cheerio.load(playerResponse.data);
          const playerScript = player$('script')
            .filter((i, el) => $(el).html().includes('var sources = ['))
            .html();
          if (playerScript) {
            const sourcesMatch = playerScript.match(/var sources = \[(.*?)\];/s);
            if (sourcesMatch) {
              const sources = sourcesMatch[1];
              const fileMatch = sources.match(/file: "(.*?)"/) || sources.match(/src: "(.*?)"/);
              if (fileMatch) {
                streamUrl = fileMatch[1];
                console.log(`Nalezen stream URL z player stránky: ${streamUrl}`);
                break;
              }
            }
          }
        }
      }
    }

    // Extract subtitles from var tracks (Kodi approach)
    const tracksScript = $('script')
      .filter((i, el) => $(el).html().includes('var tracks = '))
      .html();
    if (tracksScript) {
      const tracksMatch = tracksScript.match(/var tracks = (.*?);/s);
      if (tracksMatch) {
        try {
          const tracksData = JSON.parse(tracksMatch[1]);
          if (tracksData && tracksData[0] && tracksData[0].src) {
            subtitles = [{ url: tracksData[0].src, lang: 'cs' }];
            console.log(`Nalezeny titulky: ${tracksData[0].src}`);
          }
        } catch (err) {
          console.error(`Chyba při parsování titulků na ${videoPageUrl}: ${err.message}`);
        }
      }
    }

    if (!streamUrl) {
      console.error(`Žádný stream URL nenalezen na ${videoPageUrl}`);
      return null;
    }

    return { url: streamUrl, subtitles };
  } catch (err) {
    console.error(`Chyba při získávání stream URL z ${videoPageUrl}: ${err.message}`);
    return null;
  }
}

// Function to search on prehraj.to (mimic Kodi's search)
async function searchPrehrajTo(query) {
  try {
    const normalizedQuery = normalizeString(query);
    console.log(`Normalizovaný dotaz: ${normalizedQuery}`);
    const queries = [
      normalizedQuery,
      `${normalizedQuery} ${new Date().getFullYear()}`,
      `${normalizedQuery} 4K`,
      query
    ];

    const items = [];
    const maxResults = 10;

    for (const q of queries) {
      let page = 1;
      while (items.length < maxResults) {
        const url = `${BASE_URL}/hledej/${encodeURIComponent(q)}?vp-page=${page}`;
        console.log(`Vyhledávám na prehraj.to s dotazem: ${q}, stránka: ${page}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'kodi/prehraj.to',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;cs;q=0.5',
            'Referer': BASE_URL,
          },
        });
        const $ = cheerio.load(response.data);
        console.log(`Délka HTML odpovědi: ${response.data.length}`);

        // Debug: Save HTML for analysis
        if (process.env.DEBUG_HTML) {
          require('fs').writeFileSync(`debug_${q}_${page}.html`, response.data);
          console.log(`HTML uloženo do debug_${q}_${page}.html`);
        }

        const titles = $('h3.video__title');
        const sizes = $('div.video__tag--size');
        const times = $('div.video__tag--time');
        const links = $('a.video--link');

        if (titles.length === 0) {
          console.log(`Žádné výsledky pro dotaz: ${q}, stránka: ${page}`);
          break;
        }

        for (let i = 0; i < titles.length && items.length < maxResults; i++) {
          const title = $(titles[i]).text().trim();
          const size = $(sizes[i]).text().trim() || 'Není známo';
          const time = $(times[i]).text().trim() || 'Není známo';
          const href = $(links[i]).attr('href');

          if (href) {
            items.push({
              title: `${title} [${size} - ${time}]`,
              url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
            });
          }
        }

        page++;
        if (!$('div.pagination-more').length) {
          console.log(`Žádné další stránky pro dotaz: ${q}`);
          break;
        }
      }
      if (items.length > 0) break;
    }

    console.log(`Nalezeno ${items.length} položek pro dotaz: ${query}`);

    const streamItems = [];
    for (const item of items) {
      const streamData = await getStreamUrl(item.url);
      if (streamData) {
        streamItems.push({
          title: item.title,
          url: streamData.url,
          subtitles: streamData.subtitles,
        });
      }
    }
    console.log(`Nalezeno ${streamItems.length} platných stream URL pro dotaz: ${query}`);
    return streamItems;
  } catch (err) {
    console.error(`Chyba vyhledávání pro dotaz ${query}: ${err.message}`);
    return [];
  }
}

// Stream handler for Stremio
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`Zpracovávám požadavek na stream pro typ: ${type}, id: ${id}`);
  try {
    const query = await getTitleFromTMDB(id);
    const results = await searchPrehrajTo(query);
    const streams = results.map((item) => ({
      title: item.title,
      url: item.url,
      externalUrl: true,
      subtitles: item.subtitles,
    }));
    console.log(`Vracím ${streams.length} streamů pro ${id}`);
    return { streams };
  } catch (err) {
    console.error(`Chyba handleru streamů pro ${id}: ${err.message}`);
    return { streams: [] };
  }
});

// Create HTTP server using stremio-addon-sdk's serveHTTP
const PORT = process.env.PORT || 10000;
console.log(`Spouštím server na portu ${PORT}`);
serveHTTP(builder.getInterface(), { port: PORT }, () => {
  console.log(`HTTP addon dostupný na: http://0.0.0.0:${PORT}/manifest.json`);
});

// Health check endpoint for Render
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

healthServer.listen(8080, '0.0.0.0', () => {
  console.log('Health check server běží na portu 8080');
});
