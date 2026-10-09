import { ForbiddenException } from '@nestjs/common';
export { BusinessRuleException } from '../../common/errors/errors';
export class ForbiddenLike extends ForbiddenException {
  constructor(message: string, code = 'FORBIDDEN') { super({ error: code, message }); }
}
