const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

app.use('/', createProxyMiddleware({
    target: 'https://api.telegram.org',
    changeOrigin: true,
    secure: true,
}));

app.listen(3000, () => console.log('Proxy running on port 3000'));
