require('dotenv').config();
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');

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
    // Remove episode suffix (e.g., :1:1)
    const cleanImdbId = imdbId.split(':')[0];
    if (!cleanImdbId.startsWith('tt') || !/tt\d{7,8}/.test(cleanImdbId)) {
      throw new Error('Invalid IMDb ID format');
    }

    // Try Czech title first
    let title;
    let response = await axios.get(
      `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=cs-CZ`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      }
    );
    title = response.data.movie_results[0]?.title || response.data.tv_results[0]?.name;

    // Fallback to English title if Czech title is not found
    if (!title) {
      response = await axios.get(
        `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=en-US`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        }
      );
      title = response.data.movie_results[0]?.title || response.data.tv_results[0]?.name;
    }

    if (!title) {
      throw new Error(`No title found for IMDb ID: ${cleanImdbId}`);
    }
    console.log(`TMDB query for ${cleanImdbId}: ${title}`);
    return title;
  } catch (err) {
    console.error(`TMDB API error for ${imdbId}:`, err.message);
    throw err;
  }
}

// Function to extract direct stream URL and subtitles from prehraj.to video page
async function getStreamUrl(videoPageUrl) {
  try {
    const response = await axios.get(videoPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://prehraj.to/',
      },
    });
    const $ = cheerio.load(response.data);

    // Find the script tag containing "var sources = [...]"
    const sourcesPattern = /var sources = \[(.*?)\];/s;
    const script = $('script').filter((i, el) => {
      return $(el).html().includes('var sources = [');
    }).html();

    let streamUrl = null;
    if (script) {
      const sourcesMatch = script.match(sourcesPattern);
      if (sourcesMatch) {
        const sources = sourcesMatch[1];
        const fileMatch = sources.match(/file: "(.*?)"/);
        if (fileMatch) {
          streamUrl = fileMatch[1];
          console.log(`Extracted stream URL: ${streamUrl}`);
        } else {
          console.error(`No file URL found in sources on ${videoPageUrl}`);
        }
      } else {
        console.error(`No sources array found in script on ${videoPageUrl}`);
      }
    } else {
      console.error(`No script with sources found on ${videoPageUrl}`);
    }

    // Fallback: Try to find src: "..." if file: "..." fails
    if (!streamUrl) {
      const srcMatch = script ? script.match(/src: "(.*?)"/) : null;
      if (srcMatch) {
        streamUrl = srcMatch[1];
        console.log(`Extracted fallback stream URL: ${streamUrl}`);
      } else {
        console.error(`No src URL found in script on ${videoPageUrl}`);
      }
    }

    // Optionally extract subtitles from var tracks = ...
    let subtitles = null;
    const tracksPattern = /var tracks = (.*?);/s;
    const tracksScript = $('script').filter((i, el) => {
      return $(el).html().includes('var tracks = ');
    }).html();
    if (tracksScript) {
      const tracksMatch = tracksScript.match(tracksPattern);
      if (tracksMatch) {
        try {
          const tracksData = JSON.parse(tracksMatch[1]);
          if (tracksData && tracksData[0] && tracksData[0].src) {
            subtitles = [{ url: tracksData[0].src, lang: 'cs' }];
            console.log(`Extracted subtitles: ${tracksData[0].src}`);
          }
        } catch (err) {
          console.error(`Error parsing tracks on ${videoPageUrl}:`, err.message);
        }
      }
    }

    if (!streamUrl) {
      return null;
    }

    return { url: streamUrl, subtitles };
  } catch (err) {
    console.error(`Error fetching stream URL from ${videoPageUrl}:`, err.message);
    return null;
  }
}

// Function to search on prehraj.to
async function searchPrehrajTo(query) {
  try {
    const url = `${BASE_URL}/hledej/${encodeURIComponent(query)}`;
    console.log(`Searching prehraj.to with query: ${query}`);
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://prehraj.to/',
      },
    });
    const $ = cheerio.load(response.data);
    console.log(`HTML response length: ${response.data.length}`);
    // Debug: Print first 2 video items' HTML
    $('.video-list .video').slice(0, 2).each((i, el) => {
      console.log(`Video item ${i + 1} HTML: ${$(el).html()}`);
    });

    const items = [];
    $('.video-list .video').each((i, el) => {
      const title = $(el).find('.info .title').text().trim();
      const href = $(el).find('a').attr('href');
      const resolution = $(el).find('.info .quality').text().trim() || 'Unknown';
      const lang = $(el).find('.info .lang').text().trim() || 'Unknown';

      if (href) {
        items.push({
          title: `${title} [${resolution} - ${lang}]`,
          url: `${BASE_URL}${href}`,
        });
      }
    });
    console.log(`Found ${items.length} items for query: ${query}`);

    // Fetch direct stream URLs and subtitles for each item
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
    console.log(`Found ${streamItems.length} valid stream URLs for query: ${query}`);
    return streamItems;
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
      subtitles: item.subtitles,
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
  console.log(`HTTP addon accessible at: http://0.0.0.0:${PORT}/manifest.json`);
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

// Start health server on a different port
healthServer.listen(8080, '0.0.0.0', () => {
  console.log('Health check server running on port 8080');
});
