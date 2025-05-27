require('dotenv').config();
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const Hjson = require('hjson');
const puppeteer = require('puppeteer');

// Configuration
const BASE_URL = 'https://prehraj.to';
const TMDB_API_KEY = process.env.TMDB_KEY;

if (!TMDB_API_KEY) {
  console.error('Chyba: TMDB_KEY není definován v .env nebo v prostředí');
  process.exit(1);
}

// Define the addon
const builder = new addonBuilder({
  id: 'org.stremio.prehrajto',
  version: '1.0.12',
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

// Function to format season and episode
function formatSeasonEpisode(season, episode) {
  const s = season.toString().padStart(2, '0');
  const e = episode.toString().padStart(2, '0');
  return [
    `S${s}E${e}`, // S02E01
    `${season}x${episode.toString().padStart(2, '0')}` // 2x01
  ];
}

// Function to get title and year from TMDB using IMDb ID
async function getTitleFromTMDB(imdbId, type, season, episode) {
  try {
    const cleanImdbId = imdbId.split(':')[0];
    if (!cleanImdbId.startsWith('tt') || !/tt\d{7,8}/i.test(cleanImdbId)) {
      throw new Error('Neplatný formát IMDb ID');
    }

    let title, czechTitle, year;
    let response = await axios.get(
      `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id&language=cs-CZ`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
    );
    const movieResult = response.data.movie_results[0];
    const tvResult = response.data.tv_results[0];
    title = movieResult?.title || tvResult?.name;
    czechTitle = title;
    year = movieResult?.release_date?.split('-')[0] || tvResult?.first_air_date?.split('-')[0];

    if (!title) {
      response = await axios.get(
        `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id&language=en-US`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
      );
      const movieResult = response.data.movie_results[0];
      const tvResult = response.data.tv_results[0];
      title = movieResult?.title || tvResult?.name;
      year = movieResult?.release_date?.split('-')[0] || tvResult?.first_air_date?.split('-')[0];
    }

    if (!title) {
      throw new Error(`Nenalezen název pro IMDb ID: ${cleanImdbId}`);
    }

    console.log(`TMDB dotaz pro ${cleanImdbId}: ${title} (CZ: ${czechTitle}, Year: ${year})`);
    return { title, czechTitle: czechTitle || title, year, season, episode };
  } catch (err) {
    console.error(`TMDB API chyba pro ${imdbId}: ${err.message}`);
    throw err;
  }
}

// Function to extract direct stream URL and subtitles from prehraj.to video page
async function getStreamUrl(videoPageUrl) {
  try {
    console.log(`Načítám stránku videa: ${videoPageUrl}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const response = await axios.get(videoPageUrl, {
      headers: {
        'User-Agent': 'kodi/prehraj.to',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;cs;q=0.5',
        'Referer': BASE_URL,
        'Connection': 'keep-alive',
      },
    });
    const $ = cheerio.load(response.data);

    let streamUrl = null;
    let subtitles = null;

    // Extract stream URL from var sources
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
    }

    // Fallback: Check for video tags
    if (!streamUrl) {
      const videoSource = $('video source').attr('src') || $('#video-wrap video').attr('src');
      if (videoSource) {
        streamUrl = videoSource.startsWith('http') ? videoSource : `${BASE_URL}${videoSource}`;
        console.log(`Nalezen stream z video tagu: ${streamUrl}`);
      }
    }

    // Extract subtitles from var tracks using Hjson
    const tracksScript = $('script')
      .filter((i, el) => $(el).html().includes('var tracks = '))
      .html();
    if (tracksScript) {
      const tracksMatch = tracksScript.match(/var tracks = (.*?);/s);
      if (tracksMatch) {
        try {
          const tracksData = Hjson.parse(tracksMatch[1]);
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

// Function to search on prehraj.to using puppeteer
async function searchPrehrajTo(query, type, season, episode, year) {
  try {
    const normalizedQuery = normalizeString(query);
    console.log(`Normalizovaný dotaz: ${normalizedQuery}`);
    let queries = [];

    if (type === 'series' && season && episode) {
      const episodeFormats = formatSeasonEpisode(season, episode);
      queries = [
        ...episodeFormats.map(fmt => `${query} ${fmt}`),
        ...episodeFormats.map(fmt => `${normalizedQuery} ${fmt}`),
        ...episodeFormats.map(fmt => `${query} ${fmt} CZ`),
        ...episodeFormats.map(fmt => `${normalizedQuery} ${fmt} CZ`),
        query,
        normalizedQuery
      ];
    } else {
      const titleVariants = [
        query,
        query.replace('&', 'a'),
        normalizedQuery,
        normalizedQuery.replace('&', 'a')
      ];
      queries = [
        ...titleVariants,
        ...titleVariants.map(t => `${t} ${year || new Date().getFullYear()}`),
        ...titleVariants.map(t => `${t} 4K`),
        ...titleVariants.map(t => `${t} CZ`),
        ...titleVariants.map(t => `${t} topkvalita`)
      ];
    }

    queries = [...new Set(queries)];
    console.log(`Testované dotazy: ${queries.join(', ')}`);

    const items = [];
    const maxResults = 10;

    // Use puppeteer to scrape dynamically loaded content
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    for (const q of queries) {
      let pageNum = 1;
      while (items.length < maxResults) {
        const url = `${BASE_URL}/hledej/${encodeURIComponent(q)}?vp-page=${pageNum}`;
        console.log(`Vyhledávám na prehraj.to s dotazem: ${q}, stránka: ${pageNum}`);

        const page = await browser.newPage();
        await page.setUserAgent('kodi/prehraj.to');
        await page.goto(url, { waitUntil: 'networkidle2' });

        const content = await page.content();
        const $ = cheerio.load(content);

        const titles = $('h3.video__title');
        const sizes = $('div.video__tag--size');
        const times = $('div.video__tag--time');
        const links = $('a.video--link');

        if (titles.length) {
          console.log(`Nalezeno ${titles.length} výsledků pro dotaz: ${q}, stránka: ${pageNum}`);
        } else {
          console.log(`Žádné výsledky pro dotaz: ${q}, stránka: ${pageNum}`);
          const altTitles = $('.video__title, .video-title, .title');
          console.log(`Alternativní selektory nalezly ${altTitles.length} výsledků`);
          await page.close();
          break;
        }

        for (let i = 0; i < titles.length && items.length < maxResults; i++) {
          const title = $(titles[i]).text().trim();
          const size = $(sizes[i])?.text().trim() || 'Není známo';
          const time = $(times[i])?.text().trim() || 'Není známo';
          const href = $(links[i])?.attr('href');

          if (href) {
            items.push({
              title: `${title} [${size} - ${time}]`,
              url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
            });
          }
        }

        await page.close();
        pageNum++;
        if (!$('div.pagination-more').length) {
          console.log(`Žádné další stránky pro dotaz: ${q}`);
          break;
        }
      }
      if (items.length > 0) break;
    }

    await browser.close();

    console.log(`Celkem nalezeno ${items.length} položek pro dotaz: ${query}`);

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
    console.log(`Nalezeno ${streamItems.length} platných streamů pro dotaz: ${query}`);
    return streamItems;
  } catch (err) {
    console.error(`Chyba vyhledávání pro dotaz: ${query}: ${err.message}`);
    return [];
  }
}

// Stream handler for Stremio
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`Zpracovávám požadavek pro typ: ${type}, id: ${id}`);
  try {
    let season, episode;
    let cleanId = id;

    // Parse season and episode for series
    if (type === 'series' && id.includes(':')) {
      const parts = id.split(':');
      cleanId = parts[0];
      season = parseInt(parts[1], 10);
      episode = parseInt(parts[2], 10);
    }

    const { title, czechTitle, year } = await getTitleFromTMDB(cleanId, type, season, episode);
    const query = type === 'series' ? czechTitle : title; // Prefer Czech title for series
    const results = await searchPrehrajTo(query, type, season, episode, year);
    const streams = results.map((item) => ({
      title: item.title,
      url: item.url,
      externalUrl: true,
      subtitles: item.subtitles
    }));
    console.log(`Vracím ${streams.length} streamů pro ${id}`);
    return { streams };
  } catch (err) {
    console.error(`Chyba handleru streamů pro ${id}: ${err.message}`);
    return { streams: [] };
  }
});

// Create HTTP server
const PORT = process.env.PORT || 8000;
console.log(`Spouštím server na portu ${PORT}`);
serveHTTP(builder.getInterface(), { port: PORT }, () => {
  console.log(`HTTP addon dostupný na: http://0.0.0.0:${PORT}/manifest.json`);
});

// Health check endpoint
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

healthServer.listen(8080, () => {
  console.log('Health check server běží na portu 8080');
});
