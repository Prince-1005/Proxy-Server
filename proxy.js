const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// Health check — keeps Render alive
app.get('/', (req, res) => res.status(200).send('Telegram proxy running ✅'));

// Forward ALL requests to api.telegram.org
// Telegraf sends to: https://your-proxy.onrender.com/botTOKEN/METHOD
// This forwards it to: https://api.telegram.org/botTOKEN/METHOD
app.use('/', createProxyMiddleware({
    target:       'https://api.telegram.org',
    changeOrigin: true,
    secure:       true,
    on: {
        error: (err, req, res) => {
            console.error('Proxy error:', err.message);
            res.status(502).json({ error: 'Proxy error', message: err.message });
        },
    },
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🔀 Telegram proxy running on port ${PORT}`);
    console.log(`📡 Forwarding all requests → https://api.telegram.org`);
});
