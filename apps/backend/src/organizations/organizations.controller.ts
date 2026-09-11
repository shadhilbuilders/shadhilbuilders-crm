// Organizations controller - JWT-protected tenant lookup for slug-based
// routing.
//
// GET /organizations/by-slug/:slug is the ONLY route here for now: it lets
// the server-side OrganizationLayout resolve the [orgSlug] URL segment to
// the Organization (then pages/context use org.id for id-keyed APIs).
// RLS is org-gated, so a caller who cannot access the org gets 404 (the
// policy filters the row out) - fail-closed by construction.
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { OrganizationsService } from './organizations.service';

@ApiTags('organizations')
@ApiBearerAuth('jwt')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    @Inject(OrganizationsService)
    private readonly organizations: OrganizationsService,
  ) {}

  @Get('by-slug/:slug')
  @ApiOperation({
    summary:
      'Resolve an organization by slug (for the [orgSlug] URL segment). ' +
      'Returns the org id + slug so the client can key id-based hooks/APIs.',
  })
  async bySlug(
    @Req() req: AuthedRequest,
    @Param('slug') slug: string,
  ): Promise<{ id: string; name: string; slug: string }> {
    const org = await this.organizations.findBySlug(req.user!, slug);
    if (org === null) {
      throw new NotFoundException('Organization not found or not accessible');
    }
    return org;
  }

  @Get()
  @ApiOperation({
    summary:
      'List the organizations the caller can access (id + slug). Lets the ' +
      'client resolve an id-keyed session/API result back to a slug for ' +
      'href building (e.g. the root / redirect).',
  })
  async list(
    @Req() req: AuthedRequest,
  ): Promise<Array<{ id: string; name: string; slug: string }>> {
    return this.organizations.list(req.user!);
  }
}
