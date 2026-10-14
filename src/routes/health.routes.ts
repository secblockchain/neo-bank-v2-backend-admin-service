import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { getHealth } from '../controllers/health/getHealth';

const router = Router();

router.get('/', asyncHandler(getHealth));

export default router;
