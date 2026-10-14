/**
 * Express app — same middleware pipeline as the other US services.
 * Exported separately so tests can import it without opening a port.
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import routes from './routes';
import {
  corsOptions,
  helmetConfig,
  securityHeaders,
  bodySizeLimiter,
} from './middlewares/security';
import { requestIdMiddleware, httpLogger } from './middlewares/requestLogger';
import { globalErrorHandler } from './middlewares/globalErrorHandler';
import { notFoundHandler } from './middlewares/notFound';
import { config } from './config/environment';

const app = express();

app.set('trust proxy', config.TRUST_PROXY);

app.use(helmetConfig);
app.use(securityHeaders);
app.use(cors(corsOptions));

app.use(express.json({ limit: config.BODY_SIZE_LIMIT }));
app.use(requestIdMiddleware);
app.use(httpLogger);
app.use(express.urlencoded({ extended: true, limit: config.BODY_SIZE_LIMIT }));
app.use(bodySizeLimiter);
app.use(cookieParser());

app.use('/', routes);

app.use(notFoundHandler);
app.use(globalErrorHandler);

export default app;
