// Shared types for the projects module that come from @shadhil/api-types
// plus the PrismaClient shape. Kept in a separate file so the service's
// public surface (ProjectRow / ProjectListResult) can be re-exported
// without importing the Zod schemas into every consumer.
import type { PrismaClient as DbPrismaClient } from '@shadhil/database';
import type {
  CreateProjectDto as ApiCreateProjectDto,
  ProjectFilterDto as ApiProjectFilterDto,
  ProjectListResult as ApiProjectListResult,
  ProjectRow as ApiProjectRow,
  UpdateProjectDto as ApiUpdateProjectDto,
} from '@shadhil/api-types';

export type ProjectRow = ApiProjectRow;
export type ProjectListResult = ApiProjectListResult;
export type ProjectFilterDto = ApiProjectFilterDto;
export type CreateProjectDto = ApiCreateProjectDto;
export type UpdateProjectDto = ApiUpdateProjectDto;

// The withRlsContext tx is the Omit<>ed client (no lifecycle methods);
// helpers accept that shape directly (see the leads.service.ts pattern).
export type PrismaClient = DbPrismaClient;