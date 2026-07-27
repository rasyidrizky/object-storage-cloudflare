import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';

@ApiTags('Auth Test')
@Controller('auth')
export class AppController {
  constructor(private readonly jwtService: JwtService) { }

  @Get('token')
  @ApiOperation({ summary: 'Generate a test JWT token (For development only)' })
  @ApiQuery({ name: 'sub', type: Number, required: false, description: 'User ID (defaults to 1)' })
  @ApiQuery({ name: 'role', type: String, required: false, description: 'User role (e.g. user, admin)' })
  getToken(@Query('sub') sub?: string, @Query('role') role?: string) {
    const payload = { 
      sub: sub ? parseInt(sub, 10) : 1, 
      role: role || 'user' 
    };
    const token = this.jwtService.sign(payload);
    return {
      message: 'Copy this token and paste it in the Swagger Authorize button',
      token,
      payload,
    };
  }
}
