require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http");

const builder = new addonBuilder({
  id: "org.stremio.prehrajto",
  version: "1.0.0",
  name: "Prehraj.to",
  description: "Streams from prehraj.to",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [] // důležité – musí být pole, i když prázdné
});

function imdbToQuery(imdbId) {
  return axios
    .get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${process.env.TMDB_KEY}&external_source=imdb_id`)
    .then(res => {
      const title = res.data.movie_results[0]?.title || res.data.tv_results[0]?.name;
      return title;
    });
}

async function searchPrehrajTo(query) {
  const url = `https://prehraj.to/hledej/${encodeURIComponent(query)}`;
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(response.data);

  const items = [];
  $('.video-block').each((i, el) => {
    const title = $(el).find('.video-title').text().trim();
    const href = $(el).find('a').attr('href');
    const resolution = $(el).find('.label-quality').text().trim();
    const lang = $(el).find('.label-lang').text().trim();

    if (href) {
      items.push({
        title: `${title} [${resolution} - ${lang}]`,
        url: `https://prehraj.to${href}`
      });
    }
  });
  return items;
}

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const query = await imdbToQuery(id);
    const results = await searchPrehrajTo(query);
    const streams = results.map(item => ({
      title: item.title,
      url: item.url,
      externalUrl: true
    }));
    return Promise.resolve({ streams });
  } catch (err) {
    console.error(err);
    return { streams: [] };
  }
});

// 🔧 HTTP server pro Render (poslouchá na správném portu)
http
  .createServer(builder.getInterface())
  .listen(process.env.PORT || 7000, "0.0.0.0");

console.log("Stremio addon running on port " + (process.env.PORT || 7000));

