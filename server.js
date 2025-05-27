require('dotenv').config();
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// Basic configuration
const BASE_URL = process.env.PREHRAJTO_BASE_URL || 'https://prehraj.to';
const TMDB_API_KEY = process.env.TMDB_KEY;

if (!TMDB_API_KEY) {
  throw new Error('TMDB_KEY is not defined in .env');
}

// Define the addon
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

// Function to get title from TMDB using IMDb ID
async function imdbToQuery(imdbId) {
  try {
    if (!imdbId.startsWith('tt') || !/tt\d{7,8}/.test(imdbId)) {
      throw new Error('Invalid IMDb ID format');
    }
    const response = await axios.get(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      }
    );
    const title = response.data.movie_results[0]?.title || response.data.tv_results[0]?.name;
    if (!title) {
      throw new Error(`No title found for IMDb ID: ${imdbId}`);
    }
    console.log(`TMDB query for ${imdbId}: ${title}`);
    return title;
  } catch (err) {
    console.error(`TMDB API error for ${imdbId}:`, err.message);
    throw err;
  }
}

// Function to search on prehraj.to
async function searchPrehrajTo(query) {
  try {
    const url = `${BASE_URL}/hledej/${encodeURIComponent(query)}`;
    console.log(`Searching prehraj.to with query: ${query}`);
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

// Stream handler for Stremio
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`Processing stream request for type: ${type}, id: ${id}`);
  try {
    const query = await imdbToQuery(id);
    const results = await searchPrehrajTo(query);
    const streams = results.map((item) => ({
      title: item.title,
      url: item.url,
      externalUrl: true,
    }));
    console.log(`Returning ${streams.length} streams for ${id}`);
    return { streams };
  } catch (err) {
    console.error(`Stream handler error for ${id}:`, err.message);
    return { streams: [] };
  }
});

// Create HTTP server using stremio-addon-sdk's serveHTTP
const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT }, () => {
  console.log(`Stremio addon running on port ${PORT}`);
});

// Health check endpoint for Render
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

// Start health server on a different port (optional, only if Render requires a separate health check)
healthServer.listen(8080, '0.0.0.0', () => {
  console.log('Health check server running on port 8080');
});
