import express from 'express';
import { createApiRouter } from '../server.ts';

// Vercel invokes this file as the serverless API function. The frontend remains
// the Vite build output, while every /api/* request is handled by the same
// router used by the local Express server.
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', createApiRouter());

export default app;
