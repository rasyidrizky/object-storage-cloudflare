import { 
  Controller, 
  Post, 
  Get, 
  Delete, 
  Param, 
  Body,
  UseInterceptors, 
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  BadRequestException,
  UseGuards,
  Query,
  ParseIntPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiParam, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { StorageService } from './storage.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';

@ApiTags('Storage')
@ApiBearerAuth()
@Controller('')
@UseGuards(JwtAuthGuard)
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Post('upload')
  @ApiOperation({ summary: 'Upload a file to R2 storage' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
        logicalKey: {
          type: 'string',
          description: 'Optional. Provide an existing logicalKey to upload a new version.',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'File successfully uploaded' })
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }), // 10MB limit
          new FileTypeValidator({ fileType: '.(png|jpeg|jpg|pdf|mp4|webp)' }),
        ],
        fileIsRequired: true,
      }),
    )
    file: Express.Multer.File,
    @CurrentUser() user: any,
    @Body('logicalKey') logicalKey?: string,
  ) {
    const result = await this.storageService.uploadFile(file, user.sub, logicalKey);
    return result;
  }

  @Post('presign-upload')
  @ApiOperation({ summary: 'Get a presigned URL to upload a file directly from client' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        fileName: { type: 'string', example: 'image.jpg' },
        contentType: { type: 'string', example: 'image/jpeg' },
        size: { type: 'number' },
        hash: { type: 'string' },
        logicalKey: { type: 'string', description: 'Optional. Provide to upload a new version.' },
      },
      required: ['fileName', 'contentType'],
    },
  })
  @ApiResponse({ status: 201, description: 'Returns the presigned URL and file info' })
  async getPresignedPutUrl(@Body() body: { fileName: string; contentType: string; size?: number; hash?: string, logicalKey?: string }, @CurrentUser() user: any) {
    if (!body.fileName || !body.contentType) {
      throw new BadRequestException('fileName and contentType are required');
    }
    return await this.storageService.getPresignedPutUrl(body.fileName, body.contentType, body.size, body.hash, user.sub, body.logicalKey);
  }

  @Post('multipart/start')
  @ApiOperation({ summary: 'Start a multipart upload' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        fileName: { type: 'string', example: 'large-video.mp4' },
        contentType: { type: 'string', example: 'video/mp4' },
        size: { type: 'number' },
        hash: { type: 'string' },
        logicalKey: { type: 'string', description: 'Optional. Provide to upload a new version.' },
      },
      required: ['fileName', 'contentType'],
    },
  })
  @ApiResponse({ status: 201, description: 'Returns the uploadId and file info' })
  async startMultipartUpload(@Body() body: { fileName: string; contentType: string; size?: number; hash?: string, logicalKey?: string }, @CurrentUser() user: any) {
    if (!body.fileName || !body.contentType) {
      throw new BadRequestException('fileName and contentType are required');
    }
    return await this.storageService.startMultipartUpload(body.fileName, body.contentType, body.size, body.hash, user.sub, body.logicalKey);
  }

  @Post('multipart/presign-part')
  @ApiOperation({ summary: 'Get a presigned URL for a specific part of a multipart upload' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        uploadId: { type: 'string' },
        partNumber: { type: 'number', example: 1 },
      },
      required: ['key', 'uploadId', 'partNumber'],
    },
  })
  @ApiResponse({ status: 201, description: 'Returns the presigned URL for the part' })
  async getMultipartPreSignedUrl(@Body() body: { key: string; uploadId: string; partNumber: number }) {
    if (!body.key || !body.uploadId || !body.partNumber) {
      throw new BadRequestException('key, uploadId, and partNumber are required');
    }
    const url = await this.storageService.getMultipartPreSignedUrl(body.key, body.uploadId, body.partNumber);
    return { url };
  }

  @Post('multipart/complete')
  @ApiOperation({ summary: 'Complete a multipart upload' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        uploadId: { type: 'string' },
        parts: { 
          type: 'array', 
          items: {
            type: 'object',
            properties: {
              ETag: { type: 'string' },
              PartNumber: { type: 'number' }
            }
          } 
        },
        size: { type: 'number' },
        hash: { type: 'string' },
      },
      required: ['key', 'uploadId', 'parts'],
    },
  })
  @ApiResponse({ status: 201, description: 'Multipart upload completed successfully' })
  async completeMultipartUpload(@Body() body: { key: string; uploadId: string; parts: { ETag: string; PartNumber: number }[]; size?: number; hash?: string }) {
    if (!body.key || !body.uploadId || !body.parts || !Array.isArray(body.parts)) {
      throw new BadRequestException('key, uploadId, and parts array are required');
    }
    await this.storageService.completeMultipartUpload(body.key, body.uploadId, body.parts, body.size, body.hash);
    return { message: 'Multipart upload completed successfully' };
  }

  @Post('presign/complete')
  @ApiOperation({ summary: 'Complete a presigned upload' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        size: { type: 'number' },
        hash: { type: 'string' },
      },
      required: ['key'],
    },
  })
  @ApiResponse({ status: 201, description: 'Presigned upload completed successfully' })
  async completePresignedUpload(@Body() body: { key: string; size?: number; hash?: string }) {
    if (!body.key) {
      throw new BadRequestException('key is required');
    }
    await this.storageService.completePresignedUpload(body.key, body.size, body.hash);
    return { message: 'Presigned upload completed successfully' };
  }

  @Get('files')
  @ApiOperation({ summary: 'List uploaded files (current versions)' })
  @ApiResponse({ status: 200, description: 'Returns a list of files' })
  async listFiles() {
    return this.storageService.listFiles();
  }

  @Get('files/:logicalKey')
  @ApiOperation({ summary: 'Get a presigned URL to access the current version of the file' })
  @ApiParam({ name: 'logicalKey', description: 'The logical key of the file group' })
  @ApiResponse({ status: 200, description: 'Returns the presigned URL' })
  async getFileUrl(@Param('logicalKey') logicalKey: string, @CurrentUser() user: any) {
    const url = await this.storageService.getPresignedUrl(logicalKey, user);
    return { url };
  }

  @Get('files/:logicalKey/versions')
  @ApiOperation({ summary: 'List all versions for a logical file' })
  @ApiParam({ name: 'logicalKey', description: 'The logical key of the file group' })
  @ApiResponse({ status: 200, description: 'Returns all versions' })
  async listVersions(@Param('logicalKey') logicalKey: string, @CurrentUser() user: any) {
    return this.storageService.listVersions(logicalKey, user);
  }

  @Get('files/:logicalKey/versions/:version')
  @ApiOperation({ summary: 'Get a presigned URL for a specific version' })
  @ApiParam({ name: 'logicalKey', description: 'The logical key' })
  @ApiParam({ name: 'version', type: Number, description: 'The version number' })
  @ApiResponse({ status: 200, description: 'Returns the presigned URL' })
  async getFileUrlForVersion(@Param('logicalKey') logicalKey: string, @Param('version', ParseIntPipe) version: number, @CurrentUser() user: any) {
    const url = await this.storageService.getPresignedUrl(logicalKey, user, version);
    return { url };
  }

  @Post('files/:logicalKey/rollback/:version')
  @ApiOperation({ summary: 'Rollback a logical file to a specific version (sets it as current)' })
  @ApiParam({ name: 'logicalKey', description: 'The logical key' })
  @ApiParam({ name: 'version', type: Number, description: 'The version number to rollback to' })
  @ApiResponse({ status: 200, description: 'Rollback successful' })
  async rollbackVersion(@Param('logicalKey') logicalKey: string, @Param('version', ParseIntPipe) version: number, @CurrentUser() user: any) {
    return this.storageService.rollbackVersion(logicalKey, version, user);
  }

  @Delete('files/:logicalKey')
  @ApiOperation({ summary: 'Delete a logical file and all its versions from storage' })
  @ApiParam({ name: 'logicalKey', description: 'The logical key to delete' })
  @ApiResponse({ status: 200, description: 'File successfully deleted' })
  async deleteFile(@Param('logicalKey') logicalKey: string, @CurrentUser() user: any) {
    await this.storageService.deleteFile(logicalKey, user);
    return { message: 'File deleted successfully' };
  }
}
