require('dotenv').config();
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = process.env.PREHRAJTO_BASE_URL || 'https://prehraj.to';
const TMDB_API_KEY = process.env.TMDB_KEY;

if (!TMDB_API_KEY) {
  throw new Error('TMDB_KEY is not defined in .env');
}

const builder = new addonBuilder({
  id: 'org.stremio.prehrajto',
  version: '1.0.0',
  name: 'Prehraj.to',
  description: 'Streams from prehraj.to',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  logo: 'https://stremio.com/website/stremio-logo.png',
  behaviorHints: { adult: false },
});

async function imdbToQuery(imdbId) {
  try {
    if (!imdbId.startsWith('tt') || !/tt\d{7,8}/.test(imdbId)) {
      throw new Error('Invalid IMDb ID format');
    }
    const response = await axios.get(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );
    const title = response.data.movie_results[0]?.title || response.data.tv_results[0]?.name;
    if (!title) throw new Error(`No title found for IMDb ID: ${imdbId}`);
    console.log(`TMDB query for ${imdbId}: ${title}`);
    return title;
  } catch (err) {
    console.error(`TMDB API error for ${imdbId}:`, err.message);
    throw err;
  }
}

async function extractVideoUrl(videoPageUrl) {
  try {
    const res = await axios.get(videoPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
      },
    });
    const $ = cheerio.load(res.data);
    const scriptContent = $('script').filter((i, el) => $(el).html().includes('var sources = [')).html();
    const match = scriptContent?.match(/file: \"(https:\\/\\/[^\"]+)\"/);
    if (match && match[1]) {
      const decodedUrl = match[1].replace(/\\\//g, '/');
      return decodedUrl;
    }
  } catch (err) {
    console.error(`extractVideoUrl error: ${err.message}`);
  }
  return null;
}

async function searchPrehrajTo(query) {
  try {
    const url = `${BASE_URL}/hledej/${encodeURIComponent(query)}`;
    console.log(`Searching prehraj.to with query: ${query}`);
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
      },
    });
    const $ = cheerio.load(response.data);
    const items = [];
    $('.video-block').each((i, el) => {
      const title = $(el).find('.video-title').text().trim();
      const href = $(el).find('a').attr('href');
      const resolution = $(el).find('.label-quality').text().trim() || 'Unknown';
      const lang = $(el).find('.label-lang').text().trim() || 'Unknown';
      if (href) {
        items.push({
          title: `${title} [${resolution} - ${lang}]`,
          url: `${BASE_URL}${href}`,
        });
      }
    });
    console.log(`Found ${items.length} items for query: ${query}`);
    return items;
  } catch (err) {
    console.error(`Search error for query ${query}:`, err.message);
    return [];
  }
}

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`Processing stream request for type: ${type}, id: ${id}`);
  try {
    const cleanId = id.split(':')[0];
    const query = await imdbToQuery(cleanId);
    const results = await searchPrehrajTo(query);

    const streams = await Promise.all(results.map(async (item) => {
      const realUrl = await extractVideoUrl(item.url);
      if (!realUrl) return null;
      return {
        title: item.title,
        url: realUrl,
        externalUrl: true,
      };
    }));

    const filtered = streams.filter(Boolean);
    console.log(`Returning ${filtered.length} streams for ${id}`);
    return { streams: filtered };
  } catch (err) {
    console.error(`Stream handler error for ${id}:`, err.message);
    return { streams: [] };
  }
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT }, () => {
  console.log(`Stremio addon running on port ${PORT}`);
});

const http = require('http');
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
  console.log('Health check server running on port 8080');
});
