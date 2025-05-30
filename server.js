require('dotenv').config();
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const puppeteer = require('puppeteer-core'); // Používáme puppeteer-core
const cheerio = require('cheerio');

const PORT = process.env.PORT || 10000;
const BASE_URL = 'https://prehraj.to';
const TMDB_API_KEY = process.env.TMDB_KEY || '1f0150a5f78d4adc2407911989fdb66c';
const CACHE_TTL = 3600000; // 1 hodina

const searchCache = new Map();

const builder = new addonBuilder({
  id: 'org.stremio.prehrajto',
  version: '1.0.20',
  name: 'prehraj-to',
  description: 'Streamy z prehraj.to',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  logo: 'https://stremio.com/website/stremio-logo.png',
  behaviorHints: { adult: false },
});

function normalizeString(str) {
  const diacriticsMap = {
    'á': 'a', 'č': 'c', 'ď': 'd', 'é': 'e', 'ě': 'e', 'í': 'i', 'ň': 'n', 'ó': 'o',
    'ř': 'r', 'š': 's', 'ť': 't', 'ú': 'u', 'ů': 'u', 'ý': 'y', 'ž': 'z',
    'Á': 'A', 'Č': 'C', 'Ď': 'D', 'É': 'E', 'Ě': 'E', 'Í': 'I', 'Ň': 'N', 'Ó': 'O',
    'Ř': 'R', 'Š': 'S', 'Ť': 'T', 'Ú': 'U', 'Ů': 'U', 'Ý': 'Y', 'Ž': 'Z'
  };
  return str.replace(/[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/g, match => diacriticsMap[match] || match);
}

function formatSeasonEpisode(season, episode) {
  const s = season.toString().padStart(2, '0');
  const e = episode.toString().padStart(2, '0');
  return [`S${s}E${e}`, `${s}x${e}`, `Ep ${e}`, `Episode ${e}`];
}

async function getTitleFromTMDB(imdbId, type, season, episode) {
  const cacheKey = `tmdb:${imdbId}:${type}:${season || ''}:${episode || ''}`;
  if (searchCache.has(cacheKey)) {
    const { data, timestamp } = searchCache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) return data;
  }
  try {
    const cleanImdbId = imdbId.split(':')[0];
    if (!cleanImdbId.startsWith('tt') || !/tt\d{7,8}/i.test(cleanImdbId)) {
      throw new Error('Neplatný formát IMDb ID');
    }
    const response = await fetch(`https://api.themoviedb.org/3/find/${encodeURIComponent(cleanImdbId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id&language=cs-CZ`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      }
    });
    const data = await response.json();
    const movieResult = data.movie_results[0];
    const tvResult = data.tv_results[0];
    let title = movieResult?.title || tvResult?.name;
    let czechTitle = title;
    let year = movieResult?.release_date?.split('-')[0] || tvResult?.first_air_date?.split('-')[0];

    if (!title) {
      const responseEn = await fetch(`https://api.themoviedb.org/3/find/${encodeURIComponent(cleanImdbId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id&language=en-US`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        }
      });
      const dataEn = await responseEn.json();
      const movieResultEn = dataEn.movie_results[0];
      const tvResultEn = dataEn.tv_results[0];
      title = movieResultEn?.title || tvResultEn?.name;
      year = movieResultEn?.release_date?.split('-')[0] || tvResultEn?.first_air_date?.split('-')[0];
    }

    if (!title) throw new Error(`Nenalezen název pro IMDb ID: ${cleanImdbId}`);
    const result = { title, czechTitle: czechTitle || title, year, season, episode };
    searchCache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log(`TMDB výsledek pro ${imdbId}:`, result);
    return result;
  } catch (err) {
    console.error(`TMDB chyba pro ${imdbId}: ${err.message}`);
    return null;
  }
}

// Globální instance prohlížeče pro znovupoužití
let browserInstance;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote'
      ],
      executablePath: '/usr/bin/chromium-browser', // Cesta k Chromiu nainstalovanému přes apt-get
      timeout: 60000
    });
  }
  return browserInstance;
}

async function searchPrehrajTo(query, type, season, episode, year) {
  const cacheKey = `search:${query}:${type}:${season || ''}:${episode || ''}:${year || ''}`;
  if (searchCache.has(cacheKey)) {
    const { results, timestamp } = searchCache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) return results;
  }

  try {
    const normalizedQuery = normalizeString(query);
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
      const titleVariants = [query, query.replace('&', 'a'), normalizedQuery, normalizedQuery.replace('&', 'a')];
      queries = [
        ...titleVariants,
        ...titleVariants.map(t => `${t} ${year || new Date().getFullYear()}`),
        ...titleVariants.map(t => `${t} 4K`),
        ...titleVariants.map(t => `${t} CZ`),
        ...titleVariants.map(t => `${t} topkvalita`),
        'Minecraft: The Movie',
        'Minecraft film'
      ];
    }

    queries = [...new Set(queries)];
    const items = [];
    const maxResults = 10;
    let page = 1;

    const browser = await getBrowser();

    while (items.length < maxResults && page <= 3) {
      for (const q of queries) {
        const url = `${BASE_URL}/hledej/${encodeURIComponent(q)}?vp-page=${page}`;
        console.log(`Vyhledávám: ${url}`);

        const pageObj = await browser.newPage();
        try {
          await pageObj.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
          await pageObj.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

          const content = await pageObj.content();
          console.log(`Stažené HTML (${url}): ${content.substring(0, 200)}...`);
          const $ = cheerio.load(content);

          const titles = $('h3.video__title');
          const sizes = $('div.video__tag--size');
          const times = $('div.video__tag--time');
          const links = $('a.video--link');

          console.log(`Nalezeno ${titles.length} titulů pro dotaz ${q}`);

          for (let i = 0; i < titles.length && items.length < maxResults; i++) {
            const title = $(titles[i]).text().trim();
            const size = $(sizes[i]).text().trim() || 'Není známo';
            const time = $(times[i]).text().trim() || 'Není známo';
            const href = $(links[i]).attr('href');
            if (href) {
              items.push({
                title: `${title} [${size} - ${time}]`,
                url: href.startsWith('http') ? href : `${BASE_URL}${href}`
              });
            }
          }

          const next = $('div.pagination-more');
          console.log(`Stránkování nalezeno: ${next.length > 0}`);
          if (!next.length || items.length >= maxResults) break;

          await pageObj.close();
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (err) {
          console.error(`Chyba při vyhledávání ${q}: ${err.message}`);
          await pageObj.close();
        }
      }
      page++;
    }

    console.log(`Celkem nalezeno ${items.length} položek pro dotaz ${query}`);
    searchCache.set(cacheKey, { results: items, timestamp: Date.now() });
    return items;
  } catch (err) {
    console.error(`Chyba vyhledávání: ${err.message}`);
    return [];
  }
}

async function getStreamUrl(videoPageUrl) {
  const cacheKey = `stream:${videoPageUrl}`;
  if (searchCache.has(cacheKey)) {
    const { data, timestamp } = searchCache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) return data;
  }

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.goto(videoPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const content = await page.content();
    console.log(`Stažené HTML (${videoPageUrl}): ${content.substring(0, 200)}...`);
    const $ = cheerio.load(content);

    let streams = [];
    const scripts = $('script');
    for (let i = 0; i < scripts.length; i++) {
      const scriptContent = $(scripts[i]).html();
      if (scriptContent && /videos\.push/.test(scriptContent)) {
        const videoMatches = scriptContent.match(/videos\.push\({ src: "([^"]+)", type: 'video\/mp4', res: '(\d+)', label: '(\d+p)'/g);
        if (videoMatches) {
          for (let match of videoMatches) {
            const srcMatch = match.match(/src: "([^"]+)"/);
            const labelMatch = match.match(/label: '(\d+p)'/);
            if (srcMatch && labelMatch) {
              streams.push({
                url: srcMatch[1],
                label: labelMatch[1]
              });
            }
          }
        }
        break;
      }
    }

    console.log(`Nalezeno ${streams.length} streamů pro ${videoPageUrl}:`, streams);
    const data = streams.length > 0 ? streams : null;
    searchCache.set(cacheKey, { data, timestamp: Date.now() });
    await page.close();
    return data;
  } catch (err) {
    console.error(`Chyba při získání streamu ${videoPageUrl}: ${err.message}`);
    await page.close();
    return null;
  }
}

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`Zpracování: ${type}, ${id}`);
  try {
    let season, episode;
    let cleanId = id;

    if (type === 'series' && id.includes(':')) {
      const parts = id.split(':');
      cleanId = parts[0];
      season = parseInt(parts[1], 10);
      episode = parseInt(parts[2], 10);
    }

    const titleInfo = await getTitleFromTMDB(cleanId, type, season, episode);
    if (!titleInfo) {
      console.log(`Žádná TMDB data pro ${id}`);
      return { streams: [] };
    }

    const query = type === 'series' ? titleInfo.czechTitle : titleInfo.title;
    const results = await searchPrehrajTo(query, type, season, episode, titleInfo.year);
    const streams = [];

    for (const item of results) {
      const streamData = await getStreamUrl(item.url);
      if (streamData) {
        for (const stream of streamData) {
          streams.push({
            title: `${item.title} (${stream.label})`,
            url: stream.url,
            externalUrl: true
          });
        }
      }
    }

    console.log(`Nalezeno ${streams.length} streamů pro ${id}:`, streams);
    return { streams };
  } catch (err) {
    console.error(`Chyba handleru: ${err.message}`);
    return { streams: [] };
  } finally {
    if (browserInstance) {
      await browserInstance.close();
      browserInstance = null;
    }
  }
});

serveHTTP(builder.getInterface(), { port: PORT, host: '0.0.0.0' }, () => {
  console.log(`HTTP addon accessible at: http://127.0.0.1:${PORT}/manifest.json`);
});
