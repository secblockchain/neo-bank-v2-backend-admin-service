import { Router } from 'express';
import healthRoutes from './health.routes';
import adminRoutes from './admin.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/api/v1/admin', adminRoutes);

export default router;
