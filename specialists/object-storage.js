// specialists/object-storage.js — checks if file uploads survive platform migration.
// Replit Object Storage is proprietary; Render/Railway filesystems are ephemeral.

export const checkId = 'object-storage';
export const name = 'Object Storage Configuration';
export const appliesTo = ['deployable', 'server', 'framework'];

const isFile = (p) => !p.endsWith('/');

const STORAGE_PACKAGES = [
  '@replit/object-storage',     // Must migrate
  '@aws-sdk/client-s3',         // Good — S3 or R2
  'aws-sdk',                    // Good — S3 or R2
  '@aws-sdk/s3-request-presigner',
  '@supabase/storage-js',       // Good — Supabase Storage
  '@google-cloud/storage',      // Good — GCS
  '@azure/storage-blob',        // Good — Azure
  'multer',                     // Neutral — check if using multer-s3
  'multer-s3',                  // Good — S3 uploads
  'formidable',                 // Neutral — parses uploads
  'express-fileupload',         // Neutral — check destination
];

const EXTERNAL_PACKAGES = [ // uploads go to external object storage
  '@aws-sdk/client-s3', 'aws-sdk', '@aws-sdk/s3-request-presigner',
  '@supabase/storage-js', '@google-cloud/storage', '@azure/storage-blob', 'multer-s3',
];

const UPLOAD_DIR_RE = '(?:uploads?|files?|images?|media|assets?|attachments?|documents?|storage|downloads?)';

const UPLOAD_TREE_DIRS = [
  'uploads/', 'upload/', 'files/', 'file/', 'images/', 'image/', 'media/',
  'assets/', 'attachments/', 'attachment/', 'documents/', 'document/',
  'storage/', 'downloads/', 'download/',
  'public/uploads/', 'public/files/', 'public/media/', 'public/images/', 'public/assets/',
];

const FS_UPLOAD_PATTERNS = [
  new RegExp(`fs\\.writeFile(?:Sync)?\\s*\\(\\s*['"\`][^'"\`]*${UPLOAD_DIR_RE}`, 'i'),
  new RegExp(`fs\\.promises\\.writeFile\\s*\\(\\s*['"\`][^'"\`]*${UPLOAD_DIR_RE}`, 'i'),
  new RegExp(`fs\\.appendFile(?:Sync)?\\s*\\(\\s*['"\`][^'"\`]*${UPLOAD_DIR_RE}`, 'i'),
  new RegExp(`createWriteStream\\s*\\(\\s*['"\`][^'"\`]*${UPLOAD_DIR_RE}`, 'i'),
  new RegExp(`fs\\.(?:rename|copyFile)(?:Sync)?\\s*\\(\\s*[^,]*,\\s*['"\`][^'"\`]*${UPLOAD_DIR_RE}`, 'i'),
  new RegExp(`path\\.join\\s*\\([^)]*['"\`][^'"\`]*${UPLOAD_DIR_RE}`, 'i'),
  new RegExp(`express\\.static\\s*\\(\\s*['"\`][^'"\`]*${UPLOAD_DIR_RE}`, 'i'),
  /multer\.diskStorage/i,
  new RegExp(`uploadDir\\s*:\\s*['"\`][^'"\`]*${UPLOAD_DIR_RE}`, 'i'),
];

const SERVER_PATH_RE = /^(src|app|api|routes|lib|server|controllers|middleware|handlers|pages|functions|workers|services|modules|bin)\//;

export async function check(context) {
  const { tree, files, packageJson } = context;

  try {
    if (!Array.isArray(tree) || tree.length === 0) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Empty repo — no object storage needed', findings: [] };
    }

    const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const hasReplitStorage = !!deps['@replit/object-storage'];
    const hasS3 = !!(deps['@aws-sdk/client-s3'] || deps['aws-sdk']);
    const hasMulter = !!deps['multer'];
    const hasMulterS3 = !!deps['multer-s3'];
    const hasExternal = EXTERNAL_PACKAGES.some(p => deps[p]);
    const hasAnyStorage = STORAGE_PACKAGES.some(p => deps[p]);
    const hasUploadsDir = tree.some(p => UPLOAD_TREE_DIRS.some(prefix => p.startsWith(prefix)));
    const findings = [];

    if (hasReplitStorage) {
      findings.push({ file: 'package.json', issue: '@replit/object-storage detected — Use Cloudflare R2: npm install @aws-sdk/client-s3. Free tier: 10GB storage + 1M reads/mo' });
      return { checkId, status: 'fail', confidence: 'high', message: 'Replit Object Storage detected — will break on migration. Migrate to Cloudflare R2 or AWS S3', findings };
    }

    let hasLocalUpload = false;
    const sourceFiles = tree.filter(p => {
      if (!isFile(p)) return false;
      if (!/\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p)) return false;
      if (/node_modules/.test(p)) return false;
      if (/\.test\.|\.spec\.|__tests__|__mocks__/.test(p)) return false;
      return true;
    }).sort((a, b) => {
      const aScore = SERVER_PATH_RE.test(a) || !a.includes('/') ? 1 : 0;
      const bScore = SERVER_PATH_RE.test(b) || !b.includes('/') ? 1 : 0;
      return bScore - aScore;
    }).slice(0, 12);

    for (const filePath of sourceFiles) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const isImportLine = /^\s*(?:import|const|let|var)\b/.test(line) && /(?:require|from)\s*\(?\s*['"\`]/.test(line);
          if (isImportLine) continue;
          for (const pat of FS_UPLOAD_PATTERNS) {
            if (pat.test(line)) {
              findings.push({ file: filePath, line: i + 1, issue: 'File upload writes to local disk — will be lost on platform restart' });
              hasLocalUpload = true;
              break;
            }
          }
        }
      } catch (e) {
        console.error(`object-storage: error reading ${filePath}:`, e.message);
      }
    }

    const multerNoS3 = hasMulter && !hasMulterS3 && !hasS3;
    if (multerNoS3) {
      findings.push({ file: 'package.json', issue: 'multer detected without multer-s3 — uploads stored on local disk. Use @aws-sdk/client-s3 with multer memory storage + S3 upload.' });
    }

    if (hasUploadsDir && !hasExternal) {
      findings.push({ file: 'uploads/', issue: 'Uploads directory found with no external object storage — files will be lost on restart' });
    }

    if (hasLocalUpload || (hasUploadsDir && !hasExternal)) {
      return { checkId, status: 'fail', confidence: 'high', message: 'File uploads stored on local disk — filesystem is ephemeral on Render/Railway. Use S3/R2', findings };
    }
    if (multerNoS3) {
      return { checkId, status: 'fail', confidence: 'high', message: 'File uploads stored on local disk — use @aws-sdk/client-s3 with multer + S3 upload', findings };
    }
    if (hasMulter && hasMulterS3) {
      return { checkId, status: 'pass', confidence: 'high', message: 'File uploads configured with S3 storage', findings };
    }
    if (hasExternal) {
      const label = hasS3 ? 'S3/R2' : EXTERNAL_PACKAGES.find(p => deps[p]) || 'external provider';
      return { checkId, status: 'pass', confidence: 'high', message: `Object storage configured: ${label} detected`, findings };
    }
    if (hasAnyStorage) {
      return { checkId, status: 'check-it', confidence: 'medium', message: 'Upload parsing library detected with no external object storage — verify uploads are not written to local disk', findings };
    }
    return { checkId, status: 'not-applicable', confidence: 'high', message: 'No file upload or object storage detected', findings: [] };

  } catch (err) {
    console.error('object-storage check error:', err);
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [{ file: 'internal', issue: err.message }] };
  }
}