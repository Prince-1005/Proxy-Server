const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// Health check
app.get('/', (req, res) => res.status(200).send('Telegram proxy running'));

// Forward everything to api.telegram.org
app.use('/', createProxyMiddleware({
    target:      'https://api.telegram.org',
    changeOrigin: true,
    secure:      true,
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔀 Telegram proxy running on port ${PORT}`));
