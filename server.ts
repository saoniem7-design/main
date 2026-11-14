import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { createServer as createViteServer } from 'vite';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_FILE = path.join(DATA_DIR, 'attendance_db.json');

async function ensureDirectories() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

function getTodayDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function atomicWriteJson(filePath: string, payload: unknown) {
  const tempPath = `${filePath}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
  await fs.rename(tempPath, filePath);
}

async function startServer() {
  await ensureDirectories();

  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/db', async (_req, res) => {
    try {
      const raw = await fs.readFile(DB_FILE, 'utf-8');
      res.json({ exists: true, data: JSON.parse(raw) });
    } catch {
      res.json({ exists: false, data: null });
    }
  });

  app.post('/api/db', async (req, res) => {
    try {
      const db = req.body;
      if (!db || !Array.isArray(db.students) || !Array.isArray(db.staff)) {
        res.status(400).json({ error: 'Invalid database payload structure.' });
        return;
      }
      const savedAt = new Date().toISOString();
      db.settings = { ...db.settings, lastSavedAt: savedAt };

      await atomicWriteJson(DB_FILE, db);

      // Automatic daily backup if enabled and today's auto backup does not yet exist
      if (db.settings?.autoDailyBackup) {
        const autoName = `auto_backup_${getTodayDateString()}.json`;
        const autoPath = path.join(BACKUP_DIR, autoName);
        try {
          await fs.access(autoPath);
        } catch {
          db.settings.lastBackupAt = savedAt;
          await atomicWriteJson(autoPath, db);
          await atomicWriteJson(DB_FILE, db);
        }
      }

      res.json({ ok: true, savedAt });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to save database to disk.',
      });
    }
  });

  app.get('/api/backups', async (_req, res) => {
    try {
      await ensureDirectories();
      const files = await fs.readdir(BACKUP_DIR);
      const summaries = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const fullPath = path.join(BACKUP_DIR, file);
        const stat = await fs.stat(fullPath);
        let studentCount = 0;
        let staffCount = 0;
        let attendanceCount = 0;
        try {
          const parsed = JSON.parse(await fs.readFile(fullPath, 'utf-8'));
          studentCount = parsed.students?.length || 0;
          staffCount = parsed.staff?.length || 0;
          attendanceCount =
            (parsed.studentAttendance?.length || 0) + (parsed.staffAttendance?.length || 0);
        } catch {
          // ignore malformed preview counts
        }
        const type = file.startsWith('auto_backup_')
          ? 'Auto Daily'
          : file.startsWith('pre_restore_')
            ? 'Pre-Restore'
            : 'Manual';
        summaries.push({
          filename: file,
          createdAt: stat.mtime.toISOString(),
          type,
          sizeBytes: stat.size,
          studentCount,
          staffCount,
          attendanceCount,
        });
      }
      summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.json({ backups: summaries });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to list backups.',
      });
    }
  });

  app.post('/api/backups', async (req, res) => {
    try {
      await ensureDirectories();
      const now = new Date();
      const stamp = `${getTodayDateString()}_${String(now.getHours()).padStart(2, '0')}-${String(
        now.getMinutes()
      ).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
      const filename = `manual_backup_${stamp}.json`;
      const targetPath = path.join(BACKUP_DIR, filename);

      let payload = req.body;
      if (!payload || !Array.isArray(payload.students)) {
        const raw = await fs.readFile(DB_FILE, 'utf-8');
        payload = JSON.parse(raw);
      }
      const backupTime = now.toISOString();
      payload.settings = { ...payload.settings, lastBackupAt: backupTime };
      await atomicWriteJson(targetPath, payload);
      await atomicWriteJson(DB_FILE, payload);

      res.json({ ok: true, filename, createdAt: backupTime });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to create backup.',
      });
    }
  });

  app.get('/api/backups/:filename', async (req, res) => {
    try {
      const safeName = path.basename(req.params.filename);
      const targetPath = path.join(BACKUP_DIR, safeName);
      const raw = await fs.readFile(targetPath, 'utf-8');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.send(raw);
    } catch {
      res.status(404).json({ error: 'Backup file not found.' });
    }
  });

  app.post('/api/backups/restore', async (req, res) => {
    try {
      await ensureDirectories();
      const { filename, data } = req.body as { filename?: string; data?: unknown };

      // Create safety pre-restore snapshot if current DB exists
      try {
        const currentRaw = await fs.readFile(DB_FILE, 'utf-8');
        const safetyName = `pre_restore_${Date.now()}.json`;
        await fs.writeFile(path.join(BACKUP_DIR, safetyName), currentRaw, 'utf-8');
      } catch {
        // no existing DB yet
      }

      let restoredData: Record<string, unknown>;
      if (filename) {
        const safeName = path.basename(filename);
        const raw = await fs.readFile(path.join(BACKUP_DIR, safeName), 'utf-8');
        restoredData = JSON.parse(raw);
      } else if (data && typeof data === 'object') {
        restoredData = data as Record<string, unknown>;
      } else {
        res.status(400).json({ error: 'Provide either a backup filename or JSON database payload.' });
        return;
      }

      if (!Array.isArray(restoredData.students) || !Array.isArray(restoredData.staff)) {
        res.status(400).json({ error: 'Invalid backup file: missing required tables.' });
        return;
      }

      await atomicWriteJson(DB_FILE, restoredData);
      res.json({ ok: true, data: restoredData });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Restore failed.',
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`EduPulse Attendance ERP running on http://localhost:${PORT}`);
  });
}

startServer();
