import { Body, Controller, INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Max, Min } from 'class-validator';
import request from 'supertest';
import { DomainExceptionFilter } from './error.filter';

class CreateLeadDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(0)
  @Max(999)
  count!: number;
}

@Controller('leads')
class LeadsController {
  @Post()
  create(@Body() dto: CreateLeadDto) {
    return { ok: true, name: dto.name };
  }
}

/**
 * The validation contract from docs/02-specs/api/conventions.md, exercised through a
 * real request rather than asserted in prose.
 */
describe('request validation', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [LeadsController] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a well-formed body', async () => {
    await request(app.getHttpServer())
      .post('/leads')
      .send({ name: 'Rina', count: 3 })
      .expect(201, { ok: true, name: 'Rina' });
  });

  it('rejects an unknown field rather than silently dropping it', async () => {
    // A typo'd field name that is quietly ignored is among the hardest bugs to find:
    // the client believes it sent something the server never saw.
    const res = await request(app.getHttpServer())
      .post('/leads')
      .send({ name: 'Rina', count: 3, kpmId: 'kpm-b' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body)).toContain('kpmId');
  });

  it('does not coerce a number into a string — @IsString() must actually mean it', async () => {
    // With enableImplicitConversion on, 42 becomes "42" before validation and this
    // request would succeed. That is why it is off.
    const res = await request(app.getHttpServer())
      .post('/leads')
      .send({ name: 42, count: 3 })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('name');
  });

  it('reports every field violation, not just the first', async () => {
    const res = await request(app.getHttpServer())
      .post('/leads')
      .send({ name: 42, count: 5000 })
      .expect(400);

    const body = JSON.stringify(res.body);
    expect(body).toContain('name');
    expect(body).toContain('count');
  });

  it('renders validation failures in the standard envelope with a request id', async () => {
    const res = await request(app.getHttpServer()).post('/leads').send({}).expect(400);
    expect(res.body).toHaveProperty('error.code');
    expect(res.body).toHaveProperty('error.message');
    expect(res.body).toHaveProperty('error.requestId');
  });
});
