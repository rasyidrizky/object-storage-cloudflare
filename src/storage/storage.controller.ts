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
  BadRequestException
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiParam, ApiResponse } from '@nestjs/swagger';
import { StorageService } from './storage.service';

@ApiTags('Storage')
@Controller('')
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
      },
    },
  })
  @ApiResponse({ status: 201, description: 'File successfully uploaded', type: String })
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }), // 10MB limit
        ],
        fileIsRequired: true,
      }),
    )
    file: Express.Multer.File,
  ) {
    const key = await this.storageService.uploadFile(file);
    return { key };
  }

  @Post('presign-upload')
  @ApiOperation({ summary: 'Get a presigned URL to upload a file directly from client' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        fileName: { type: 'string', example: 'image.jpg' },
        contentType: { type: 'string', example: 'image/jpeg' },
      },
      required: ['fileName', 'contentType'],
    },
  })
  @ApiResponse({ status: 201, description: 'Returns the presigned URL and file key' })
  async getPresignedPutUrl(@Body() body: { fileName: string; contentType: string }) {
    if (!body.fileName || !body.contentType) {
      throw new BadRequestException('fileName and contentType are required');
    }
    return await this.storageService.getPresignedPutUrl(body.fileName, body.contentType);
  }

  @Get('files/:key')
  @ApiOperation({ summary: 'Get a presigned URL to access the file' })
  @ApiParam({ name: 'key', description: 'The file key returned from upload' })
  @ApiResponse({ status: 200, description: 'Returns the presigned URL' })
  async getFileUrl(@Param('key') key: string) {
    const url = await this.storageService.getPresignedUrl(key);
    return { url };
  }

  @Delete('files/:key')
  @ApiOperation({ summary: 'Delete a file from storage' })
  @ApiParam({ name: 'key', description: 'The file key to delete' })
  @ApiResponse({ status: 200, description: 'File successfully deleted' })
  async deleteFile(@Param('key') key: string) {
    await this.storageService.deleteFile(key);
    return { message: 'File deleted successfully' };
  }
}
