import { Injectable, InternalServerErrorException, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
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

  private async getNextVersionInfo(fileName: string, existingLogicalKey?: string): Promise<{ logicalKey: string, version: number, key: string }> {
    const ext = path.extname(fileName);
    let logicalKey = existingLogicalKey || randomUUID();
    let version = 1;

    if (existingLogicalKey) {
      const latest = await this.prisma.fileMetadata.findFirst({
        where: { logicalKey: existingLogicalKey },
        orderBy: { version: 'desc' },
      });
      if (latest) {
        version = latest.version + 1;
      }
    }

    const key = `${logicalKey}/v${version}${ext}`;
    return { logicalKey, version, key };
  }

  private async updateCurrentVersionFlag(logicalKey: string) {
    await this.prisma.fileMetadata.updateMany({
      where: { logicalKey, isCurrent: true },
      data: { isCurrent: false },
    });
  }

  async uploadFile(file: Express.Multer.File, uploaderId?: number, existingLogicalKey?: string): Promise<{ logicalKey: string, version: number, key: string }> {
    try {
      const { logicalKey, version, key } = await this.getNextVersionInfo(file.originalname, existingLogicalKey);
      const hash = createHash('sha256').update(file.buffer).digest('hex');

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      });

      await this.s3Client.send(command);

      if (existingLogicalKey) {
        await this.updateCurrentVersionFlag(logicalKey);
      }

      await this.prisma.fileMetadata.create({
        data: {
          key,
          logicalKey,
          version,
          isCurrent: true,
          size: file.size,
          mimeType: file.mimetype,
          hash,
          status: 'UPLOADED',
          uploaderId,
        },
      });

      return { logicalKey, version, key };
    } catch (error) {
      throw new InternalServerErrorException(`Failed to upload file: ${error.message}`);
    }
  }

  async getPresignedPutUrl(fileName: string, contentType: string, size?: number, hash?: string, uploaderId?: number, existingLogicalKey?: string): Promise<{ url: string; key: string, logicalKey: string, version: number }> {
    try {
      const { logicalKey, version, key } = await this.getNextVersionInfo(fileName, existingLogicalKey);

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
      });

      const url = await getSignedUrl(this.s3Client, command, { expiresIn: 900 });

      if (existingLogicalKey) {
        await this.updateCurrentVersionFlag(logicalKey);
      }

      await this.prisma.fileMetadata.create({
        data: {
          key,
          logicalKey,
          version,
          isCurrent: true,
          size,
          mimeType: contentType,
          hash,
          status: 'PENDING',
          uploaderId,
        },
      });

      return { url, key, logicalKey, version };
    } catch (error) {
      throw new InternalServerErrorException(`Failed to generate presigned PUT URL: ${error.message}`);
    }
  }

  async getPresignedUrl(logicalKey: string, user: { sub: number; role: string }, version?: number): Promise<string> {
    try {
      const file = await this.prisma.fileMetadata.findFirst({
        where: { logicalKey, ...(version ? { version } : { isCurrent: true }) }
      });
      if (!file) throw new NotFoundException('File not found');

      if (file.uploaderId !== user.sub && user.role !== 'admin') {
        throw new ForbiddenException('You do not have access to this file');
      }

      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: file.key,
      });
      return await getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
    } catch (error) {
      if (error.status === 403 || error.status === 404) throw error;
      throw new InternalServerErrorException(`Failed to generate presigned URL: ${error.message}`);
    }
  }

  async deleteFile(logicalKey: string, user: { sub: number; role: string }): Promise<void> {
    try {
      const latestFile = await this.prisma.fileMetadata.findFirst({
        where: { logicalKey, isCurrent: true }
      });

      if (!latestFile) {
        throw new NotFoundException('File not found');
      }

      if (latestFile.uploaderId !== user.sub && user.role !== 'admin') {
        throw new ForbiddenException('You do not have permission to delete this file');
      }

      const allVersions = await this.prisma.fileMetadata.findMany({
        where: { logicalKey }
      });

      for (const file of allVersions) {
        const command = new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: file.key,
        });
        await this.s3Client.send(command).catch(() => {});
      }

      await this.prisma.fileMetadata.deleteMany({
        where: { logicalKey },
      });
    } catch (error) {
      if (error.status === 403 || error.status === 404) throw error;
      throw new InternalServerErrorException(`Failed to delete file: ${error.message}`);
    }
  }

  async startMultipartUpload(fileName: string, contentType: string, size?: number, hash?: string, uploaderId?: number, existingLogicalKey?: string): Promise<{ uploadId: string; key: string, logicalKey: string, version: number }> {
    try {
      const { logicalKey, version, key } = await this.getNextVersionInfo(fileName, existingLogicalKey);

      const command = new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
      });

      const response = await this.s3Client.send(command);
      if (!response.UploadId) {
        throw new Error('UploadId is missing from AWS response');
      }

      if (existingLogicalKey) {
        await this.updateCurrentVersionFlag(logicalKey);
      }

      await this.prisma.fileMetadata.create({
        data: {
          key,
          logicalKey,
          version,
          isCurrent: true,
          size,
          mimeType: contentType,
          hash,
          status: 'PENDING',
          uploaderId,
        },
      });

      return { uploadId: response.UploadId, key, logicalKey, version };
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

      return await getSignedUrl(this.s3Client, command, { expiresIn: 900 });
    } catch (error) {
      throw new InternalServerErrorException(`Failed to generate presigned URL for part: ${error.message}`);
    }
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[], size?: number, hash?: string): Promise<void> {
    try {
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
      where: { status: 'UPLOADED', isCurrent: true },
      orderBy: { uploadedAt: 'desc' },
    });
  }

  async listVersions(logicalKey: string, user: { sub: number; role: string }) {
    const versions = await this.prisma.fileMetadata.findMany({
      where: { logicalKey },
      orderBy: { version: 'desc' }
    });

    if (versions.length === 0) {
      throw new NotFoundException('File not found');
    }

    if (versions[0].uploaderId !== user.sub && user.role !== 'admin') {
      throw new ForbiddenException('You do not have permission to view this file');
    }

    return versions;
  }

  async rollbackVersion(logicalKey: string, versionToRollbackTo: number, user: { sub: number; role: string }) {
    const file = await this.prisma.fileMetadata.findUnique({
      where: { logicalKey_version: { logicalKey, version: versionToRollbackTo } }
    });

    if (!file) {
      throw new NotFoundException('Version not found');
    }

    if (file.uploaderId !== user.sub && user.role !== 'admin') {
      throw new ForbiddenException('You do not have permission to rollback this file');
    }

    await this.updateCurrentVersionFlag(logicalKey);

    await this.prisma.fileMetadata.update({
      where: { id: file.id },
      data: { isCurrent: true }
    });

    return { message: `Rolled back to version ${versionToRollbackTo}` };
  }
}
