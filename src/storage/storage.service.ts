import { Injectable, InternalServerErrorException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { createHash } from 'crypto';
import { 
  S3Client, 
  PutObjectCommand, 
  DeleteObjectCommand, 
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  CompletedPart
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import * as path from 'path';

@Injectable()
export class StorageService {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
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

      // Calculate SHA-256 hash
      const hash = createHash('sha256').update(file.buffer).digest('hex');

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      });

      await this.s3Client.send(command);

      // Save to database
      await this.prisma.fileMetadata.create({
        data: {
          key,
          size: file.size,
          mimeType: file.mimetype,
          hash,
          status: 'UPLOADED',
        },
      });

      return key;
    } catch (error) {
      throw new InternalServerErrorException(`Failed to upload file: ${error.message}`);
    }
  }

  async getPresignedPutUrl(fileName: string, contentType: string, size?: number, hash?: string): Promise<{ url: string; key: string }> {
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

      // Save PENDING record
      await this.prisma.fileMetadata.create({
        data: {
          key,
          size,
          mimeType: contentType,
          hash,
          status: 'PENDING',
        },
      });

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

      // Also delete from database
      await this.prisma.fileMetadata.delete({
        where: { key },
      }).catch(() => {
        // Ignore if not found in db
      });
    } catch (error) {
      throw new InternalServerErrorException(`Failed to delete file: ${error.message}`);
    }
  }

  async startMultipartUpload(fileName: string, contentType: string, size?: number, hash?: string): Promise<{ uploadId: string; key: string }> {
    try {
      const ext = path.extname(fileName);
      const key = `${randomUUID()}${ext}`;

      const command = new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
      });

      const response = await this.s3Client.send(command);
      if (!response.UploadId) {
        throw new Error('UploadId is missing from AWS response');
      }

      await this.prisma.fileMetadata.create({
        data: {
          key,
          size,
          mimeType: contentType,
          hash,
          status: 'PENDING',
        },
      });

      return { uploadId: response.UploadId, key };
    } catch (error) {
      throw new InternalServerErrorException(`Failed to start multipart upload: ${error.message}`);
    }
  }

  async getMultipartPreSignedUrl(key: string, uploadId: string, partNumber: number): Promise<string> {
    try {
      const command = new UploadPartCommand({
        Bucket: this.bucketName,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      // URL expires in 15 minutes for each part
      return await getSignedUrl(this.s3Client, command, { expiresIn: 900 });
    } catch (error) {
      throw new InternalServerErrorException(`Failed to generate presigned URL for part: ${error.message}`);
    }
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[], size?: number, hash?: string): Promise<void> {
    try {
      // S3 expects parts to be sorted by PartNumber
      const sortedParts = parts.sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));

      const command = new CompleteMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sortedParts,
        },
      });

      await this.s3Client.send(command);

      await this.prisma.fileMetadata.update({
        where: { key },
        data: {
          status: 'UPLOADED',
          ...(size && { size }),
          ...(hash && { hash }),
        },
      });
    } catch (error) {
      throw new InternalServerErrorException(`Failed to complete multipart upload: ${error.message}`);
    }
  }

  async completePresignedUpload(key: string, size?: number, hash?: string): Promise<void> {
    try {
      await this.prisma.fileMetadata.update({
        where: { key },
        data: {
          status: 'UPLOADED',
          ...(size && { size }),
          ...(hash && { hash }),
        },
      });
    } catch (error) {
      throw new InternalServerErrorException(`Failed to complete presigned upload: ${error.message}`);
    }
  }

  async listFiles() {
    return this.prisma.fileMetadata.findMany({
      where: { status: 'UPLOADED' },
      orderBy: { uploadedAt: 'desc' },
    });
  }
}
