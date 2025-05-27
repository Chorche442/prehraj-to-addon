require('dotenv').config();
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');

// Basic configuration
const BASE_URL = process.env.PREHRAJTO_BASE_URL || 'https://prehraj.to';
const TMDB_API_KEY = process.env.TMDB_KEY;
const PREHRAJTO_EMAIL = process.env.PREHRAJTO_EMAIL;
const PREHRAJTO_PASSWORD = process.env.PREHRAJTO_PASSWORD;

if (!TMDB_API_KEY) {
  throw new Error('TMDB_KEY is not defined in .env');
}

// Define the addon
const builder = new addonBuilder({
  id: 'org.stremio.prehrajto',
  version: '1.0.2',
  name: 'Prehraj.to',
  description: 'Streams from prehraj.to',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  logo: 'https://stremio.com/website/stremio-logo.png',
  behaviorHints: { adult: false },
});

// Function to get premium account cookies
async function getPremiumCookies() {
  if (!PREHRAJTO_EMAIL || !PREHRAJTO_PASSWORD) {
    console.log('No premium credentials provided, using non-premium mode');
    return { premium: false, cookies: null };
  }

  try {
    const loginData = {
      email: PREHRAJTO_EMAIL,
      password: PREHRAJTO_PASSWORD,
      _submit: 'Přihlásit se',
      remember: 'on',
      _do: 'login-loginForm-submit',
    };
    const response = await axios.post(BASE_URL, loginData, {
      headers: {
        'User-Agent': 'kodi/prehraj.to', // Mimic Kodi addon
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    });
    const $ = cheerio.load(response.data);
    const premiumIndicator = $('ul.header__links span.color-green').text();
    const premium = premiumIndicator ? true : false;
    console.log(`Premium account status: ${premium ? 'Active' : 'Inactive'}`);
    return { premium, cookies: response.headers['set-cookie'] };
  } catch (err) {
    console.error('Premium login error:', err.message);
    return { premium: false, cookies: null };
  }
}

// Function to get title from TMDB using IMDb ID
async function imdbToQuery(imdbId) {
  try {
    const cleanImdbId = imdbId.split(':')[0];
    if (!cleanImdbId.startsWith('tt') || !/tt\d{7,8}/.test(cleanImdbId)) {
      throw new Error('Invalid IMDb ID format');
    }

    let title;
    let response = await axios.get(
      `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=cs-CZ`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      }
    );
    title = response.data.movie_results[0]?.title || response.data.tv_results[0]?.name;

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
async function getStreamUrl(videoPageUrl, premium, cookies) {
  try {
    console.log(`Fetching video page: ${videoPageUrl}`);
    const headers = {
      'User-Agent': 'kodi/prehraj.to', // Mimic Kodi addon
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': BASE_URL,
    };
    const response = await axios.get(videoPageUrl, {
      headers,
      headers: cookies ? { ...headers, Cookie: cookies.join('; ') } : headers,
    });
    const $ = cheerio.load(response.data);

    let streamUrl = null;
    let subtitles = null;

    // Try to extract stream URL from var sources
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
          console.log(`Extracted stream URL: ${streamUrl}`);
        }
      }
    }

    // For premium users, try ?do=download
    if (premium && !streamUrl && cookies) {
      const downloadResponse = await axios.get(`${videoPageUrl}?do=download`, {
        headers: { ...headers, Cookie: cookies.join('; ') },
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      });
      if (downloadResponse.headers['location']) {
        streamUrl = downloadResponse.headers['location'];
        console.log(`Extracted premium stream URL from ?do=download: ${streamUrl}`);
      }
    }

    // Extract subtitles from var tracks
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
            console.log(`Extracted subtitles: ${tracksData[0].src}`);
          }
        } catch (err) {
          console.error(`Error parsing tracks on ${videoPageUrl}:`, err.message);
        }
      }
    }

    if (!streamUrl) {
      console.error(`No stream URL found on ${videoPageUrl}`);
      return null;
    }

    return { url: streamUrl, subtitles };
  } catch (err) {
    console.error(`Error fetching stream URL from ${videoPageUrl}:`, err.message);
    return null;
  }
}

// Function to search on prehraj.to
async function searchPrehrajTo(query, premium, cookies) {
  try {
    let page = 1;
    const maxResults = 10; // Limit to avoid excessive requests
    const items = [];

    while (items.length < maxResults) {
      const url = `${BASE_URL}/hledej/${encodeURIComponent(query)}?vp-page=${page}`;
      console.log(`Searching prehraj.to with query: ${query}, page: ${page}`);
      const headers = {
        'User-Agent': 'kodi/prehraj.to',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': BASE_URL,
      };
      const response = await axios.get(url, {
        headers: cookies ? { ...headers, Cookie: cookies.join('; ') } : headers,
      });
      const $ = cheerio.load(response.data);
      console.log(`HTML response length: ${response.data.length}`);

      const videos = $('.video-list .video');
      if (!videos.length) {
        console.log(`No more results found for query: ${query}`);
        break;
      }

      videos.each((i, el) => {
        const title = $(el).find('.info .title').text().trim();
        const href = $(el).find('a').attr('href');
        const size = $(el).find('.info .video__tag--size').text().trim() || 'Unknown';
        const time = $(el).find('.info .video__tag--time').text().trim() || 'Unknown';

        if (href && items.length < maxResults) {
          items.push({
            title: `${title} [${size} - ${time}]`,
            url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
          });
        }
      });

      page++;
      if (!$('div.pagination-more').length) {
        console.log('No more pages to fetch');
        break;
      }
    }

    console.log(`Found ${items.length} items for query: ${query}`);

    // Fetch direct stream URLs and subtitles for each item
    const streamItems = [];
    for (const item of items) {
      const streamData = await getStreamUrl(item.url, premium, cookies);
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
    const { premium, cookies } = await getPremiumCookies();
    const query = await imdbToQuery(id);
    const results = await searchPrehrajTo(query, premium, cookies);
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

healthServer.listen(8080, '0.0.0.0', () => {
  console.log('Health check server running on port 8080');
});
