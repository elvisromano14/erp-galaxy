import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { SequenceService } from './sequence.service';
import { AuditService } from '../audit/audit.service';

@Global()
@Module({
  providers: [PrismaService, RedisService, SequenceService, AuditService],
  exports: [PrismaService, RedisService, SequenceService, AuditService],
})
export class DbModule {}
