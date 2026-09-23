import express from 'express';
import multer from 'multer';

import {
  buildStoredAttachmentRecords,
  buildStoredImageRecords,
  ensureImageAssetsDir,
  isAllowedImageMimeType,
  openGeneratedImageAsset,
  openStoredAttachmentAsset,
} from '@/modules/assets/services/image-assets.service.js';

const router = express.Router();

// Multer writes uploads straight into the global assets folder; the service
// owns the folder location and the response record shape.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureImageAssetsDir()
      .then((assetsDir) => cb(null, assetsDir))
      .catch((error) => cb(error as Error, ''));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uniqueSuffix}-${sanitizedName}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (isAllowedImageMimeType(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 5,
  },
});

const attachmentUpload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 10,
  },
});

/**
 * Stores chat image attachments in the global `~/.cloudcli/assets` folder and
 * returns their absolute paths for use in provider prompts and chat history.
 */
router.post('/images', (req, res) => {
  upload.array('images', 5)(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      return res.status(400).json({ error: message });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No image files provided' });
    }

    res.json({ images: buildStoredImageRecords(files) });
  });
});

/**
 * Stores provider-neutral chat attachments. Files of any MIME type are
 * accepted because providers inspect them as data through their file-reading
 * tools; uploads are capped at 10 files and 10MB per file.
 */
router.post('/files', (req, res) => {
  attachmentUpload.array('files', 10)(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      return res.status(400).json({ error: message });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    res.json({ attachments: buildStoredAttachmentRecords(files) });
  });
});

/** One asset lookup, as the service's open helpers report it. */
type OpenedAsset = Awaited<ReturnType<typeof openStoredAttachmentAsset>>;

/**
 * Writes one asset lookup to the response: the matching error for a rejected
 * or missing file, otherwise the file itself.
 *
 * Stored-XSS hardening lives here so every asset route gets the same
 * treatment. The browser is never allowed to sniff a different type, and an
 * SVG (which can carry scripts when rendered as a document) is forced to
 * download instead of rendering inline. The chat UI is unaffected — it
 * fetches assets as blobs and shows them through <img>, where SVG scripts
 * never execute. `downloadAs` forces that same download for every type, which
 * is what keeps an uploaded active format from rendering in the application.
 */
function streamAsset(
  res: express.Response,
  asset: OpenedAsset,
  labels: { invalid: string; missing: string; readError: string },
  downloadAs?: string,
) {
  if (asset.status === 'invalid') {
    return res.status(400).json({ error: labels.invalid });
  }
  if (asset.status === 'missing') {
    return res.status(404).json({ error: labels.missing });
  }

  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (downloadAs) {
    res.setHeader('Content-Disposition', `attachment; filename="${downloadAs.replace(/["\r\n]/g, '_')}"`);
  } else if (asset.contentType === 'image/svg+xml') {
    res.setHeader('Content-Disposition', 'attachment');
  }

  asset.stream.pipe(res);
  asset.stream.on('error', (error) => {
    console.error(`${labels.readError}:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: labels.readError });
    }
  });
}

/**
 * Serves one stored image asset by filename. Only files directly inside the
 * global assets folder are reachable; traversal attempts resolve to null.
 */
router.get('/images/:filename', async (req, res) => {
  const asset = await openStoredAttachmentAsset(req.params.filename);
  streamAsset(res, asset, {
    invalid: 'Invalid asset filename',
    missing: 'Asset not found',
    readError: 'Error reading asset',
  });
});

/**
 * Serves one image a provider generated during a chat turn, addressed by the
 * absolute path the transcript carries. The service refuses anything outside
 * the generated-images folder, so this is not a general file reader.
 */
router.get('/generated-images', async (req, res) => {
  const imagePath = typeof req.query.path === 'string' ? req.query.path : '';
  const asset = await openGeneratedImageAsset(imagePath);
  streamAsset(res, asset, {
    invalid: 'Invalid generated image path',
    missing: 'Generated image not found',
    readError: 'Error reading generated image',
  });
});

/**
 * Downloads one stored non-image attachment, never rendering it inline.
 */
router.get('/files/:filename', async (req, res) => {
  const asset = await openStoredAttachmentAsset(req.params.filename);
  streamAsset(res, asset, {
    invalid: 'Invalid asset filename',
    missing: 'Asset not found',
    readError: 'Error reading attachment asset',
  }, req.params.filename);
});

export default router;
