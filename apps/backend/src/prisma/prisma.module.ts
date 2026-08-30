// Prisma client + RLS context module.
// Provides a Nest-injectable PrismaService and a withRlsContext helper.
import { Global, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { prisma, type PrismaClient } from '@shadhil/database';

export const PRISMA_CLIENT = Symbol('PRISMA_CLIENT');

class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly client: PrismaClient = prisma;

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  get $client(): PrismaClient {
    return this.client;
  }
}

@Global()
@Module({
  providers: [{ provide: PrismaService, useClass: PrismaService }],
  exports: [PrismaService],
})
export class PrismaModule {}
