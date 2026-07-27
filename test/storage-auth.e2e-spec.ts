import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { JwtService } from '@nestjs/jwt';

describe('StorageController (e2e)', () => {
  let app: INestApplication;
  let jwtService: JwtService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    jwtService = moduleFixture.get<JwtService>(JwtService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/files (GET) should fail without token', () => {
    return request(app.getHttpServer())
      .get('/files')
      .expect(401);
  });

  it('/files (GET) should succeed with valid token', () => {
    const token = jwtService.sign({ sub: 1, role: 'user' }, { secret: process.env.JWT_SECRET || 'fallback_secret' });
    
    return request(app.getHttpServer())
      .get('/files')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('/files/:key (DELETE) should fail if user does not own file and is not admin', async () => {
    const token1 = jwtService.sign({ sub: 1, role: 'user' }, { secret: process.env.JWT_SECRET || 'fallback_secret' });
    const token2 = jwtService.sign({ sub: 2, role: 'user' }, { secret: process.env.JWT_SECRET || 'fallback_secret' });
    
    // Upload a file as user 1
    const uploadRes = await request(app.getHttpServer())
      .post('/presign-upload')
      .set('Authorization', `Bearer ${token1}`)
      .send({ fileName: 'test.jpg', contentType: 'image/jpeg' })
      .expect(201);
      
    const fileKey = uploadRes.body.key;

    // Attempt to delete as user 2 (should fail)
    await request(app.getHttpServer())
      .delete(`/files/${fileKey}`)
      .set('Authorization', `Bearer ${token2}`)
      .expect(403);
  });

  it('/files/:key (DELETE) should succeed if user is admin', async () => {
    const token1 = jwtService.sign({ sub: 1, role: 'user' }, { secret: process.env.JWT_SECRET || 'fallback_secret' });
    const adminToken = jwtService.sign({ sub: 999, role: 'admin' }, { secret: process.env.JWT_SECRET || 'fallback_secret' });
    
    // Upload a file as user 1
    const uploadRes = await request(app.getHttpServer())
      .post('/presign-upload')
      .set('Authorization', `Bearer ${token1}`)
      .send({ fileName: 'test2.jpg', contentType: 'image/jpeg' })
      .expect(201);
      
    const fileKey = uploadRes.body.key;

    // Attempt to delete as admin (should succeed)
    await request(app.getHttpServer())
      .delete(`/files/${fileKey}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});
