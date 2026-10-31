import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';

@Injectable()
class GreeterService {
  greet(): string {
    return 'ok';
  }
}

@Controller('smoke')
class SmokeController {
  constructor(private readonly greeter: GreeterService) {}

  @Get()
  get(): { status: string } {
    return { status: this.greeter.greet() };
  }
}

@Module({ controllers: [SmokeController], providers: [GreeterService] })
class SmokeModule {}

describe('runtime NestJS sob Bun', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [SmokeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('injeta dependências por metadata de decorator e responde HTTP', async () => {
    const server = app.getHttpServer() as Server;
    const response = await request(server).get('/smoke').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
