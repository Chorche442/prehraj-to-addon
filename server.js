require('dotenv').config();
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// Definice manifestu addonu
const manifest = {
  id: 'org.stremio.prehrajto',
  version: '1.0.0',
  name: 'prehraj-to',
  description: 'Streamuje videa z prehraj.to',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  logo: 'https://stremio.com/website/stremio-logo.png',
  behaviorHints: { adult: false },
};

// Vytvoření addonu
const builder = new addonBuilder(manifest);

// Cache pro ukládání výsledků
const cache = new Map();
const CACHE_TTL = 3600000; // 1 hodina

// Funkce pro normalizaci řetězců (odstranění diakritiky)
function normalizeString(str) {
  const diacriticsMap = {
    'á': 'a', 'č': 'c', 'ď': 'd', 'é': 'e', 'ě': 'e', 'í': 'i', 'ň': 'n', 'ó': 'o',
    'ř': 'r', 'š': 's', 'ť': 't', 'ú': 'u', 'ů': 'u', 'ý': 'y', 'ž': 'z',
    'Á': 'A', 'Č': 'C', 'Ď': 'D', 'É': 'E', 'Ě': 'E', 'Í': 'I', 'Ň': 'N', 'Ó': 'O',
    'Ř': 'R', 'Š': 'S', 'Ť': 'T', 'Ú': 'U', 'Ů': 'U', 'Ý': 'Y', 'Ž': 'Z'
  };
  return str.replace(/[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/g, match => diacriticsMap[match] || match);
}

// Funkce pro získání názvu z TMDB (volitelně)
async function getTitleFromTMDB(imdbId, type) {
  const TMDB_API_KEY = process.env.TMDB_KEY || '1f0150a5f78d4adc2407911989fdb66c';
  const cacheKey = `tmdb:${imdbId}:${type}`;
  if (cache.has(cacheKey)) {
    const { data, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) return data;
  }
  try {
    const response = await axios.get(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id&language=cs-CZ`
    );
    const result = type === 'movie' ? response.data.movie_results[0] : response.data.tv_results[0];
    const title = result?.title || result?.name;
    if (!title) throw new Error(`Nenalezen název pro IMDb ID: ${imdbId}`);
    const data = { title };
    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } catch (err) {
    console.error(`TMDB chyba pro ${imdbId}: ${err.message}`);
    return null;
  }
}

// Funkce pro vyhledávání na prehraj.to
async function searchPrehrajTo(query) {
  const cacheKey = `search:${query}`;
  if (cache.has(cacheKey)) {
    const { results, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) return results;
  }
  try {
    const normalizedQuery = normalizeString(query);
    const url = `https://prehraj.to/hledej/${encodeURIComponent(normalizedQuery)}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8',
        'Cookie': 'AC=C' // Pokud je potřeba, uprav podle webu
      }
    });
    const $ = cheerio.load(response.data);
    const items = [];
    // Uprav selektory podle aktuální struktury webu
    $('.video-item').each((i, el) => {
      const title = $(el).find('h3').text().trim();
      const href = $(el).find('a').attr('href');
      if (href && href.includes('/video/')) {
        items.push({
          title,
          url: href.startsWith('http') ? href : `https://prehraj.to${href}`
        });
      }
    });
    cache.set(cacheKey, { results: items, timestamp: Date.now() });
    return items;
  } catch (err) {
    console.error(`Chyba vyhledávání: ${err.message}`);
    return [];
  }
}

// Funkce pro získání URL streamu
async function getStreamUrl(videoPageUrl) {
  const cacheKey = `stream:${videoPageUrl}`;
  if (cache.has(cacheKey)) {
    const { data, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) return data;
  }
  try {
    const response = await axios.get(videoPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8',
        'Cookie': 'AC=C' // Pokud je potřeba, uprav podle webu
      }
    });
    const $ = cheerio.load(response.data);
    let streamUrl = null;
    const videoSource = $('video source[src]').attr('src');
    if (videoSource) {
      streamUrl = videoSource.startsWith('http') ? videoSource : `https://prehraj.to${videoSource}`;
    } else {
      // Pokud je stream načítán dynamicky, zkus najít v scriptu
      const scripts = $('script');
      for (let i = 0; i < scripts.length; i++) {
        const scriptContent = $(scripts[i]).html();
        if (scriptContent && scriptContent.includes('var sources = [')) {
          const sourcesMatch = scriptContent.match(/var sources = \[(.*?)\];/s);
          if (sourcesMatch) {
            const fileMatch = sourcesMatch[1].match(/file: "(.*?)"/) || sourcesMatch[1].match(/src: "(.*?)"/);
            if (fileMatch) {
              streamUrl = fileMatch[1];
              break;
            }
          }
        }
      }
    }
    const data = streamUrl ? { url: streamUrl } : null;
    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } catch (err) {
    console.error(`Chyba při získávání streamu: ${err.message}`);
    return null;
  }
}

// Handler pro streamy
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    // Získání názvu z TMDB (volitelné, ale užitečné pro přesnější vyhledávání)
    const titleInfo = await getTitleFromTMDB(id, type);
    const query = titleInfo ? titleInfo.title : id;
    const results = await searchPrehrajTo(query);
    const streams = [];
    for (const item of results) {
      const streamData = await getStreamUrl(item.url);
      if (streamData) {
        streams.push({
          title: item.title,
          url: streamData.url,
          externalUrl: true
        });
      }
    }
    return { streams };
  } catch (err) {
    console.error(`Chyba handleru: ${err.message}`);
    return { streams: [] };
  }
});

// Spuštění serveru
const port = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port, host: '0.0.0.0' }, () => {
  console.log(`Addon běží na portu ${port}`);
});
