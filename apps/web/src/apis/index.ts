// Barrel for the API layer. The BFF client is the browser surface
// (session-cookie → /api/bff/* → NestJS); no JWT code lives client-side.
export {
  api,
  ApiError,
  qs,
  STAFF_ROLES,
  sessionUserFromSession,
  type Role,
  type SessionUser,
} from './client';