import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import * as path from 'path';

@Injectable()
export class StorageService {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    const accountId = this.configService.get<string>('R2_ACCOUNT_ID');
    const accessKeyId = this.configService.get<string>('R2_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>('R2_SECRET_ACCESS_KEY');
    this.bucketName = this.configService.get<string>('R2_BUCKET_NAME') || '';

    if (!accountId || !accessKeyId || !secretAccessKey || !this.bucketName) {
      console.warn('Cloudflare R2 credentials are not fully configured in environment variables.');
    }

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: accessKeyId || '',
        secretAccessKey: secretAccessKey || '',
      },
    });
  }

  async uploadFile(file: Express.Multer.File): Promise<string> {
    try {
      const ext = path.extname(file.originalname);
      const key = `${randomUUID()}${ext}`;

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      });

      await this.s3Client.send(command);
      return key;
    } catch (error) {
      throw new InternalServerErrorException(`Failed to upload file: ${error.message}`);
    }
  }

  async getPresignedPutUrl(fileName: string, contentType: string): Promise<{ url: string; key: string }> {
    try {
      const ext = path.extname(fileName);
      const key = `${randomUUID()}${ext}`;

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
      });

      // URL expires in 15 minutes for uploads
      const url = await getSignedUrl(this.s3Client, command, { expiresIn: 900 });
      return { url, key };
    } catch (error) {
      throw new InternalServerErrorException(`Failed to generate presigned PUT URL: ${error.message}`);
    }
  }

  async getPresignedUrl(key: string): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      // URL expires in 1 hour
      return await getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
    } catch (error) {
      throw new InternalServerErrorException(`Failed to generate presigned URL: ${error.message}`);
    }
  }

  async deleteFile(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      await this.s3Client.send(command);
    } catch (error) {
      throw new InternalServerErrorException(`Failed to delete file: ${error.message}`);
    }
  }
}
