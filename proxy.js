const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const youtubedl = require('youtube-dl-exec');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());

// ==========================================
// SUPABASE (same credentials as your HF bot)
// ==========================================
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);
const BUCKET_NAME = 'downloads';

// ==========================================
// 1. TELEGRAM API PROXY (existing)
// ==========================================
app.use('/telegram', createProxyMiddleware({
    target: 'https://api.telegram.org',
    changeOrigin: true,
    pathRewrite: { '^/telegram': '' },
    secure: true,
}));

// ==========================================
// 2. HEALTH CHECK
// ==========================================
app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Proxy + yt-dlp worker running' });
});

// ==========================================
// 3. UTILITY FUNCTIONS
// ==========================================
function sanitizeFilename(name) {
    return name.replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().substring(0, 180);
}

function extractArtist(info) {
    return (info.artist || info.creator || info.uploader || info.channel || '').replace(/"/g, '\\"');
}

function extractAlbum(info) {
    return (info.album || info.playlist_title || info.playlist || '').replace(/"/g, '\\"');
}

function downloadThumbnail(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const handleResponse = (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                https.get(response.headers.location, handleResponse).on('error', reject);
            } else {
                response.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
            }
        };
        https.get(url, handleResponse).on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

async function uploadToSupabase(filePath, bucketPath, mimeType) {
    const fileBuffer = fs.readFileSync(filePath);
    const { error: uploadError } = await supabase.storage.from(BUCKET_NAME)
        .upload(bucketPath, fileBuffer, { contentType: mimeType, upsert: true });
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data, error: urlError } = await supabase.storage.from(BUCKET_NAME)
        .createSignedUrl(bucketPath, 3600);
    if (urlError) throw new Error(`Signed URL failed: ${urlError.message}`);
    return data.signedUrl;
}

async function deleteFromBucket(bucketPath) {
    try {
        await supabase.storage.from(BUCKET_NAME).remove([bucketPath]);
        console.log(`🗑️ Deleted: ${bucketPath}`);
    } catch (e) {
        console.error('Delete error:', e.message);
    }
}

function detectActualExtension(filePath) {
    try {
        const result = execSync(
            `ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
            { stdio: 'pipe' }
        ).toString().trim();
        const map = { mp3: 'mp3', aac: 'm4a', opus: 'opus', vorbis: 'ogg', flac: 'flac' };
        return map[result] || 'm4a';
    } catch (e) { return 'm4a'; }
}

// ==========================================
// 4. FETCH INFO ENDPOINT
// POST /fetch-info  { url }
// Returns media info (title, formats, etc.)
// ==========================================
app.post('/fetch-info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    try {
        console.log(`🔍 Fetching info: ${url}`);
        const info = await youtubedl(url, {
            dumpSingleJson:     true,
            noWarnings:         true,
            noCheckCertificate: true,
        });
        res.json({ ok: true, info });
    } catch (e) {
        console.error('fetch-info error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ==========================================
// 5. DOWNLOAD VIDEO ENDPOINT
// POST /download-video { url, formatId, targetExt, bucketPath, info }
// Downloads, converts, uploads to Supabase, returns signedUrl
// ==========================================
app.post('/download-video', async (req, res) => {
    const { url, formatId, targetExt, bucketPath, info } = req.body;
    if (!url || !formatId || !targetExt || !bucketPath || !info) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const taskId    = Date.now().toString();
    const rawPath   = path.join('/tmp', `${taskId}_raw.mp4`);
    const thumbPath = path.join('/tmp', `${taskId}_thumb.jpg`);
    const title     = sanitizeFilename(info.title || 'video');
    const finalPath = path.join('/tmp', `${title}.${targetExt}`);

    try {
        console.log(`⬇️ Downloading video: ${url} → ${targetExt}`);

        // Download
        await youtubedl(url, {
            f:                  formatId,
            mergeOutputFormat:  'mp4',
            o:                  rawPath,
            noWarnings:         true,
            noCallHome:         true,
            noCheckCertificate: true,
        });

        // Thumbnail
        let hasThumbnail = false;
        if (info.thumbnail) {
            try { await downloadThumbnail(info.thumbnail, thumbPath); hasThumbnail = true; }
            catch (e) { console.warn('Thumb failed:', e.message); }
        }

        // Metadata
        const metaTitle   = (info.title    || 'video').replace(/"/g, '\\"');
        const metaArtist  = extractArtist(info);
        const metaYear    = info.upload_date ? info.upload_date.substring(0, 4) : '';
        const metaComment = (info.webpage_url || url).replace(/"/g, '\\"');

        const videoCodec = targetExt === 'webm' ? 'libvpx-vp9' : targetExt === 'avi' ? 'libxvid' : 'copy';
        const audioCodec = targetExt === 'webm' ? 'libopus'    : targetExt === 'avi' ? 'libmp3lame' : 'copy';

        let ffmpegCmd;
        if (hasThumbnail && ['mp4', 'mkv', 'mov'].includes(targetExt)) {
            ffmpegCmd = `ffmpeg -i "${rawPath}" -i "${thumbPath}" \
                -map 0 -map 1 -c:v ${videoCodec} -c:a ${audioCodec} \
                -disposition:v:1 attached_pic \
                -metadata title="${metaTitle}" -metadata artist="${metaArtist}" \
                -metadata year="${metaYear}" -metadata comment="${metaComment}" \
                -movflags +faststart "${finalPath}" -y`;
        } else {
            ffmpegCmd = `ffmpeg -i "${rawPath}" \
                -c:v ${videoCodec} -c:a ${audioCodec} \
                -metadata title="${metaTitle}" -metadata artist="${metaArtist}" \
                -metadata year="${metaYear}" -metadata comment="${metaComment}" \
                ${['mp4','mov'].includes(targetExt) ? '-movflags +faststart' : ''} \
                "${finalPath}" -y`;
        }

        execSync(ffmpegCmd, { stdio: 'pipe' });

        // Upload to Supabase
        const mimeMap  = { mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', mov: 'video/quicktime' };
        const mimeType = mimeMap[targetExt] || 'video/mp4';
        const signedUrl = await uploadToSupabase(finalPath, bucketPath, mimeType);
        const fileSizeMB = fs.statSync(finalPath).size / 1024 / 1024;

        console.log(`✅ Video ready: ${bucketPath} (${fileSizeMB.toFixed(1)}MB)`);
        res.json({ ok: true, signedUrl, fileName: `${title}.${targetExt}`, fileSizeMB });

    } catch (e) {
        console.error('download-video error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        [rawPath, thumbPath, finalPath].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
    }
});

// ==========================================
// 6. DOWNLOAD AUDIO ENDPOINT
// POST /download-audio { url, formatId, targetExt, bucketPath, info }
// ==========================================
app.post('/download-audio', async (req, res) => {
    const { url, formatId, targetExt, bucketPath, info } = req.body;
    if (!url || !formatId || !targetExt || !bucketPath || !info) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const taskId    = Date.now().toString();
    const rawBase   = path.join('/tmp', `${taskId}_raw`);
    const thumbPath = path.join('/tmp', `${taskId}_thumb.jpg`);
    const title     = sanitizeFilename(info.title || 'audio');
    const finalPath = path.join('/tmp', `${title}.${targetExt}`);

    let downloadedFile = null;

    try {
        console.log(`⬇️ Downloading audio: ${url} → ${targetExt}`);

        // Download
        await youtubedl(url, {
            f:                  formatId,
            o:                  `${rawBase}.%(ext)s`,
            noWarnings:         true,
            noCallHome:         true,
            noCheckCertificate: true,
        });

        // Find downloaded file
        downloadedFile = fs.readdirSync('/tmp')
            .filter(f => f.startsWith(`${taskId}_raw.`) && !f.endsWith('.jpg'))
            .map(f => path.join('/tmp', f))[0];
        if (!downloadedFile) throw new Error('Downloaded file not found');

        // Thumbnail
        let hasThumbnail = false;
        if (info.thumbnail) {
            try { await downloadThumbnail(info.thumbnail, thumbPath); hasThumbnail = true; }
            catch (e) { console.warn('Thumb failed:', e.message); }
        }

        // Metadata
        const metaTitle   = (info.title    || 'audio').replace(/"/g, '\\"');
        const metaArtist  = extractArtist(info);
        const metaAlbum   = extractAlbum(info);
        const metaYear    = info.upload_date ? info.upload_date.substring(0, 4) : '';
        const metaTrack   = info.track_number ? String(info.track_number) : '';
        const metaGenre   = (info.genre    || '').replace(/"/g, '\\"');
        const metaComment = (info.webpage_url || url).replace(/"/g, '\\"');

        const audioCodecMap = { mp3: 'libmp3lame', m4a: 'aac', flac: 'flac', wav: 'pcm_s16le', opus: 'libopus', ogg: 'libvorbis' };
        const audioCodec    = audioCodecMap[targetExt] || 'copy';
        const qualityFlag   = targetExt === 'mp3' ? '-q:a 0' : targetExt === 'm4a' ? '-b:a 256k' : targetExt === 'opus' ? '-b:a 192k' : targetExt === 'ogg' ? '-q:a 6' : '';

        let ffmpegCmd;
        if (targetExt === 'mp3') {
            ffmpegCmd = hasThumbnail
                ? `ffmpeg -i "${downloadedFile}" -i "${thumbPath}" \
                    -map 0:a -map 1:v -c:a ${audioCodec} ${qualityFlag} -c:v mjpeg \
                    -id3v2_version 3 \
                    -metadata:s:v title="Album cover" -metadata:s:v comment="Cover (front)" \
                    -metadata title="${metaTitle}" -metadata artist="${metaArtist}" \
                    -metadata album="${metaAlbum}" -metadata date="${metaYear}" \
                    -metadata track="${metaTrack}" -metadata genre="${metaGenre}" \
                    -metadata comment="${metaComment}" "${finalPath}" -y`
                : `ffmpeg -i "${downloadedFile}" -c:a ${audioCodec} ${qualityFlag} -id3v2_version 3 \
                    -metadata title="${metaTitle}" -metadata artist="${metaArtist}" \
                    -metadata album="${metaAlbum}" -metadata date="${metaYear}" \
                    -metadata track="${metaTrack}" -metadata genre="${metaGenre}" \
                    -metadata comment="${metaComment}" "${finalPath}" -y`;
        } else if (['wav', 'flac'].includes(targetExt)) {
            ffmpegCmd = `ffmpeg -i "${downloadedFile}" -c:a ${audioCodec} ${qualityFlag} \
                -metadata title="${metaTitle}" -metadata artist="${metaArtist}" \
                -metadata album="${metaAlbum}" -metadata date="${metaYear}" \
                -metadata track="${metaTrack}" -metadata genre="${metaGenre}" \
                -metadata comment="${metaComment}" "${finalPath}" -y`;
        } else {
            ffmpegCmd = hasThumbnail
                ? `ffmpeg -i "${downloadedFile}" -i "${thumbPath}" \
                    -map 0:a -map 1:v -c:a ${audioCodec} ${qualityFlag} -c:v mjpeg \
                    -metadata title="${metaTitle}" -metadata artist="${metaArtist}" \
                    -metadata album="${metaAlbum}" -metadata date="${metaYear}" \
                    -metadata track="${metaTrack}" -metadata genre="${metaGenre}" \
                    -metadata comment="${metaComment}" \
                    -disposition:v:0 attached_pic "${finalPath}" -y`
                : `ffmpeg -i "${downloadedFile}" -c:a ${audioCodec} ${qualityFlag} \
                    -metadata title="${metaTitle}" -metadata artist="${metaArtist}" \
                    -metadata album="${metaAlbum}" -metadata date="${metaYear}" \
                    -metadata track="${metaTrack}" -metadata genre="${metaGenre}" \
                    -metadata comment="${metaComment}" "${finalPath}" -y`;
        }

        execSync(ffmpegCmd, { stdio: 'pipe' });

        // Upload to Supabase
        const mimeMap  = { mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', wav: 'audio/wav', opus: 'audio/opus', ogg: 'audio/ogg' };
        const mimeType = mimeMap[targetExt] || 'audio/mpeg';
        const signedUrl = await uploadToSupabase(finalPath, bucketPath, mimeType);
        const fileSizeMB = fs.statSync(finalPath).size / 1024 / 1024;

        console.log(`✅ Audio ready: ${bucketPath} (${fileSizeMB.toFixed(1)}MB)`);
        res.json({ ok: true, signedUrl, fileName: `${title}.${targetExt}`, fileSizeMB });

    } catch (e) {
        console.error('download-audio error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        [downloadedFile, thumbPath, finalPath].forEach(f => {
            try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
        });
    }
});

// ==========================================
// 7. DELETE FROM BUCKET ENDPOINT
// POST /delete-file { bucketPath }
// ==========================================
app.post('/delete-file', async (req, res) => {
    const { bucketPath } = req.body;
    if (!bucketPath) return res.status(400).json({ error: 'bucketPath required' });
    await deleteFromBucket(bucketPath);
    res.json({ ok: true });
});

// ==========================================
// START
// ==========================================
const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Proxy + worker running on port ${PORT}`));
