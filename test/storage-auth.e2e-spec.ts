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

  it('should upload a file, add a version, and rollback successfully', async () => {
    const token = jwtService.sign({ sub: 1, role: 'user' }, { secret: process.env.JWT_SECRET || 'fallback_secret' });
    
    // 1. Upload version 1
    const upload1Res = await request(app.getHttpServer())
      .post('/presign-upload')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'test.jpg', contentType: 'image/jpeg' })
      .expect(201);
      
    const logicalKey = upload1Res.body.logicalKey;
    expect(upload1Res.body.version).toBe(1);

    // 2. Upload version 2
    const upload2Res = await request(app.getHttpServer())
      .post('/presign-upload')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'test.jpg', contentType: 'image/jpeg', logicalKey })
      .expect(201);
      
    expect(upload2Res.body.version).toBe(2);

    // 3. List versions
    const listRes = await request(app.getHttpServer())
      .get(`/files/${logicalKey}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
      
    expect(listRes.body.length).toBe(2);
    expect(listRes.body[0].version).toBe(2);
    expect(listRes.body[0].isCurrent).toBe(true);
    expect(listRes.body[1].version).toBe(1);
    expect(listRes.body[1].isCurrent).toBe(false);

    // 4. Rollback to version 1
    await request(app.getHttpServer())
      .post(`/files/${logicalKey}/rollback/1`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201); // Post returns 201 by default

    // 5. Verify rollback
    const listResAfter = await request(app.getHttpServer())
      .get(`/files/${logicalKey}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
      
    expect(listResAfter.body[1].version).toBe(1);
    expect(listResAfter.body[1].isCurrent).toBe(true);
    expect(listResAfter.body[0].version).toBe(2);
    expect(listResAfter.body[0].isCurrent).toBe(false);
  });

  it('/files/:logicalKey (DELETE) should fail if user does not own file and is not admin', async () => {
    const token1 = jwtService.sign({ sub: 1, role: 'user' }, { secret: process.env.JWT_SECRET || 'fallback_secret' });
    const token2 = jwtService.sign({ sub: 2, role: 'user' }, { secret: process.env.JWT_SECRET || 'fallback_secret' });
    
    const uploadRes = await request(app.getHttpServer())
      .post('/presign-upload')
      .set('Authorization', `Bearer ${token1}`)
      .send({ fileName: 'test.jpg', contentType: 'image/jpeg' })
      .expect(201);
      
    const logicalKey = uploadRes.body.logicalKey;

    await request(app.getHttpServer())
      .delete(`/files/${logicalKey}`)
      .set('Authorization', `Bearer ${token2}`)
      .expect(403);
  });

  it('/files/:logicalKey (DELETE) should succeed if user is admin', async () => {
    const token1 = jwtService.sign({ sub: 1, role: 'user' }, { secret: process.env.JWT_SECRET || 'fallback_secret' });
    const adminToken = jwtService.sign({ sub: 999, role: 'admin' }, { secret: process.env.JWT_SECRET || 'fallback_secret' });
    
    const uploadRes = await request(app.getHttpServer())
      .post('/presign-upload')
      .set('Authorization', `Bearer ${token1}`)
      .send({ fileName: 'test2.jpg', contentType: 'image/jpeg' })
      .expect(201);
      
    const logicalKey = uploadRes.body.logicalKey;

    await request(app.getHttpServer())
      .delete(`/files/${logicalKey}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});
