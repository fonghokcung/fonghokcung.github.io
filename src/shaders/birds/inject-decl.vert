// 注入 MeshStandardMaterial 顶点着色器的声明片段（#define STANDARD 之后）：
// 声明鸟群几何的自定义属性与模拟纹理采样器
attribute vec4 reference;
attribute vec4 seeds;
attribute vec3 birdColor;
uniform sampler2D texturePosition;
uniform sampler2D textureVelocity;
uniform sampler2D textureAnimation;
uniform float size;
uniform float time;
