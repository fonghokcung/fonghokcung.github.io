// 注入 MeshStandardMaterial 顶点着色器 begin_vertex 位置的位移逻辑：
// 1) 反查模拟纹理得到这只鸟的世界位置/速度
// 2) 采样动画纹理叠加翅膀扇动（morph 关键帧烘焙）
// 3) 用两个旋转矩阵把模型朝向对齐速度方向
// 4) 写入 transformed（three 内置变量，后续 lighting/投影接手）
vec4 tmpPos = texture2D( texturePosition, reference.xy );

vec3 pos = tmpPos.xyz;
vec3 velocity = normalize(texture2D( textureVelocity, reference.xy ).xyz);
vec3 aniPos = texture2D( textureAnimation, vec2( reference.z, mod( time + ( seeds.x ) * ( ( 0.0004 + seeds.y / 10000.0) + normalize( velocity ) / 20000.0 ), reference.w ) ) ).xyz;
vec3 newPosition = position;

newPosition = mat3( modelMatrix ) * ( newPosition + aniPos );
newPosition *= size + seeds.y * size * 0.2;

velocity.z *= -1.;
float xz = length( velocity.xz );
float xyz = 1.;
float x = sqrt( 1. - velocity.y * velocity.y );

float cosry = velocity.x / xz;
float sinry = velocity.z / xz;

float cosrz = x / xyz;
float sinrz = velocity.y / xyz;

mat3 maty =  mat3( cosry, 0, -sinry, 0    , 1, 0     , sinry, 0, cosry );
mat3 matz =  mat3( cosrz , sinrz, 0, -sinrz, cosrz, 0, 0     , 0    , 1 );

newPosition =  maty * matz * newPosition;
newPosition += pos;

vec3 transformed = vec3( newPosition );
