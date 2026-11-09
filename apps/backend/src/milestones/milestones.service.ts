// Milestones service (portal redesign, 2026-11-09): the staff side of the
// buyer's "what is next" card. The list is replaced as a whole, so the order the
// admin arranges is the order the buyer reads.
//
// Authorization: reads are open to every staff role (RLS narrows engineers to
// their projects and buyers to theirs); writes are ADMIN/OWNER only, with the
// RLS write policy as the second wall. The replace and its audit row share ONE
// transaction (plan A2/G-1).
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { rlsContextFrom, withRlsContext, type PrismaClient } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { ProjectMilestoneRow, ReplaceMilestonesDto } from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import { isAdminClass } from '../users/roles';

const ORDER = [{ sortOrder: 'asc' as const }, { id: 'asc' as const }];

type MilestoneSource = {
  id: string;
  name: string;
  targetDate: Date | null;
  completedAt: Date | null;
};

function toRow(m: MilestoneSource): ProjectMilestoneRow {
  return {
    id: m.id,
    name: m.name,
    targetDate: m.targetDate?.toISOString() ?? null,
    completedAt: m.completedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class MilestonesService {
  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {}

  private get client() {
    return this.prismaService.$client;
  }

  async list(actor: JwtPayload, projectId: string): Promise<ProjectMilestoneRow[]> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const rows = await (tx as unknown as PrismaClient).projectMilestone.findMany({
        where: { projectId, organizationId: actor.organizationId },
        orderBy: ORDER,
        select: { id: true, name: true, targetDate: true, completedAt: true },
      });
      return rows.map(toRow);
    });
  }

  async replace(
    actor: JwtPayload,
    projectId: string,
    dto: ReplaceMilestonesDto,
  ): Promise<ProjectMilestoneRow[]> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException(
        `Only ADMIN/OWNER can edit project milestones (actor is ${actor.role}).`,
      );
    }
    return withRlsContext(this.client, rlsContextFrom(actor), async (rawTx) => {
      const tx = rawTx as unknown as PrismaClient;
      const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (project === null) throw new NotFoundException(`Project ${projectId} not found.`);

      const where = { projectId, organizationId: actor.organizationId };
      const before = await tx.projectMilestone.findMany({
        where,
        orderBy: ORDER,
        select: { id: true, name: true, targetDate: true, completedAt: true },
      });
      await tx.projectMilestone.deleteMany({ where });
      if (dto.milestones.length > 0) {
        await tx.projectMilestone.createMany({
          data: dto.milestones.map((m, index) => ({
            projectId,
            organizationId: actor.organizationId,
            name: m.name,
            targetDate: m.targetDate ? new Date(m.targetDate) : null,
            completedAt: m.completedAt ? new Date(m.completedAt) : null,
            sortOrder: index,
          })),
        });
      }
      const after = await tx.projectMilestone.findMany({
        where,
        orderBy: ORDER,
        select: { id: true, name: true, targetDate: true, completedAt: true },
      });
      await tx.auditLog.create({
        data: {
          userId: actor.sub,
          organizationId: actor.organizationId,
          action: 'project.milestones.replace',
          entityType: 'Project',
          entityId: projectId,
          before: before.map(toRow),
          after: after.map(toRow),
          reason: `Milestones replaced by ${actor.email} (${actor.role})`,
        },
      });
      return after.map(toRow);
    });
  }
}
