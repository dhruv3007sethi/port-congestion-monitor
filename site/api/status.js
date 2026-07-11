const { DEFAULT_MODEL } = require('../lib/pipeline');

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    tavilyConfigured: !!process.env.TAVILY_API_KEY,
    openrouterConfigured: !!process.env.OPENROUTER_API_KEY,
    model: DEFAULT_MODEL
  }));
};
