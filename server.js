// server.js — Express API that connects the Mach-Speed engine to the frontend

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeRepo } from './central.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'frontend')));

// POST /api/analyze — Run deployment readiness analysis
app.post('/api/analyze', async (req, res) => {
  const { repoUrl } = req.body;

  if (!repoUrl || typeof repoUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid repoUrl field' });
  }

  // Parse owner/repo from URL
  let owner, repo;
  const trimmed = repoUrl.trim();

  // Try "owner/repo" short form first
  const shortForm = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  // Try full GitHub URL
  const fullUrl = trimmed.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);

  if (shortForm) {
    owner = shortForm[1];
    repo = shortForm[2];
  } else if (fullUrl) {
    owner = fullUrl[1];
    repo = fullUrl[2].replace(/\.git$/, '');
  } else {
    return res.status(400).json({
      error: 'Invalid repoUrl format. Use "owner/repo" or "https://github.com/owner/repo"',
    });
  }

  try {
    const result = await analyzeRepo(owner, repo);
    return res.json(result.scorecard);
  } catch (err) {
    console.error(`[ERROR] Analysis failed for ${owner}/${repo}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Fallback: serve frontend index.html for any non-API route
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Mach-Speed server running on http://localhost:${PORT}`);
});
