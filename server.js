import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5173;

// 🔽 NOVO: expõe o runtime do OCCT (JS + WASM) localmente
app.use('/vendor/occt', express.static(
  path.join(__dirname, 'node_modules/occt-import-js/dist')
));

// estáticos
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html']
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).end();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`step-quote-app running on http://localhost:${PORT}`);
});
