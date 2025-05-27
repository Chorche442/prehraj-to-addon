require('dotenv').config();
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 10000;
const BASE_URL = 'https://prehraj.to';
const TMDB_API_KEY = process.env.TMDB_KEY;
const CACHE_TTL = 3600000; // 1 hour

const searchCache = new Map();

const builder = new addonBuilder({
  id: 'org.stremio.prehrajto',
  version: '1.0.16',
  name: 'Přehraj.to',
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
  return [`S${s}E${e}`, `${s}x${e}`, `Ep. ${e}`, `Episode ${e}`];
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
    let response = await axios.get(
      `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id&language=cs-CZ`,
      { headers: { 'User-Agent': 'kodi/prehraj.to' } }
    );
    const movieResult = response.data.movie_results[0];
    const tvResult = response.data.tv_results[0];
    let title = movieResult?.title || tvResult?.name;
    let czechTitle = title;
    let year = movieResult?.release_date?.split('-')[0] || tvResult?.first_air_date?.split('-')[0];

    if (!title) {
      response = await axios.get(
        `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id&language=en-US`,
        { headers: { 'User-Agent': 'kodi/prehraj.to' } }
      );
      const movieResult = response.data.movie_results[0];
      const tvResult = response.data.tv_results[0];
      title = movieResult?.title || tvResult?.name;
      year = movieResult?.release_date?.split('-')[0] || tvResult?.first_air_date?.split('-')[0];
    }

    if (!title) throw new Error(`Nenalezen název pro IMDb ID: ${cleanImdbId}`);
    const data = { title, czechTitle: czechTitle || title, year, season, episode };
    searchCache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } catch (err) {
    console.error(`TMDB chyba pro ${imdbId}: ${err.message}`);
    return null;
  }
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
        ...titleVariants.map(t => `${t} topkvalita`)
      ];
    }

    queries = [...new Set(queries)];
    const items = [];
    const maxResults = 10;
    let page = 1;

    while (items.length < maxResults) {
      for (const q of queries) {
        const url = `${BASE_URL}/hledej/${encodeURIComponent(q)}?vp-page=${page}`;
        console.log(`Vyhledávám: ${url}`);
        try {
          const response = await axios.get(url, {
            headers: {
              'User-Agent': 'kodi/prehraj.to',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
              'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8',
              'Cookie': 'AC=C; __stripe_mid=964b43e3-f45b-4154-b1c0-4ac04f7d0cdbdaba90'
            }
          });
          const $ = cheerio.load(response.data);

          const titles = $('h3.video__title');
          const sizes = $('div.video__tag--size');
          const times = $('div.video__tag--time');
          const links = $('a.video--link');

          for (let i = 0; i < titles.length && items.length < maxResults; i++) {
            const title = $(titles[i]).text().trim();
            const size = $(sizes[i])?.text().trim() || 'Není známo';
            const time = $(times[i])?.text().trim() || 'Není známo';
            const href = $(links[i])?.attr('href');
            if (href) {
              items.push({
                title: `${title} [${size} - ${time}]`,
                url: href.startsWith('http') ? href : `${BASE_URL}${href}`
              });
            }
          }

          const next = $('div.pagination-more');
          if (!next.length || items.length >= maxResults) break;
        } catch (err) {
          console.error(`Chyba při vyhledávání ${q}: ${err.message}`);
        }
      }
      page++;
      if (page > 3) break; // Limit to 3 pages to avoid overload
    }

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

  try {
    const response = await axios.get(videoPageUrl, {
      headers: {
        'User-Agent': 'kodi/prehraj.to',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8',
        'Cookie': 'AC=C; __stripe_mid=964b43e3-f45b-4154-b1c0-4ac04f7d0cdbdaba90'
      }
    });
    const $ = cheerio.load(response.data);

    let streamUrl = null;
    const sourcesScript = $('script').filter((i, el) => $(el).html().includes('var sources = [')).html();
    if (sourcesScript) {
      const sourcesMatch = sourcesScript.match(/var sources = \[(.*?)\];/s);
      if (sourcesMatch) {
        const fileMatch = sourcesMatch[1].match(/file: "(.*?)"/) || sourcesMatch[1].match(/src: "(.*?)"/);
        if (fileMatch) streamUrl = fileMatch[1];
      }
    }

    if (!streamUrl) {
      const videoSource = $('video source').attr('src') || $('#video-wrap video').attr('src');
      if (videoSource) {
        streamUrl = videoSource.startsWith('http') ? videoSource : `${BASE_URL}${videoSource}`;
      }
    }

    const data = streamUrl ? { url: streamUrl } : null;
    searchCache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } catch (err) {
    console.error(`Chyba při získávání streamu ${videoPageUrl}: ${err.message}`);
    return null;
  }
}

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`Zpracovávám: ${type}, ${id}`);
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
    if (!titleInfo) return { streams: [] };

    const query = type === 'series' ? titleInfo.czechTitle : titleInfo.title;
    const results = await searchPrehrajTo(query, type, season, episode, titleInfo.year);
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

serveHTTP(builder.getInterface(), { port: PORT }, () => {
  console.log(`Addon běží na http://0.0.0.0:${PORT}/manifest.json`);
});
