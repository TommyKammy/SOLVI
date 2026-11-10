import { handleGLPI } from '../../../../lib/glpi/http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = (request: Request) => handleGLPI(request);
export const POST = (request: Request) => handleGLPI(request);
export const DELETE = (request: Request) => handleGLPI(request);
