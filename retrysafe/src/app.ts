import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { chargesRouter } from './routes/charges';
import { prisma } from './lib/prisma';

export const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '16kb' }));

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.use('/charges', chargesRouter);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal_server_error' });
});
