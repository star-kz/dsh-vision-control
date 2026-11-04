/**
 * `computer_digest` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 1）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
export function registerComputerDigest(env) {
  const { safeRegister, defineTracedTool, call, toLosslessJson } = env;
  safeRegister(defineTracedTool({
    name: 'computer_digest',
    description:
      'Fingerprint one screen rectangle: a short hex digest of what those pixels look like now, with no image attached. Use it to watch a corner (a progress bar, a status field) for change — ask again and compare the digests yourself, or hand the digest to computer_actions.wait_for with mode:"matches" + expected_digest so the worker waits for you. Coordinates are absolute virtual-desktop pixels, the same ones the computer_screenshot envelope reports. Requires 电脑操作.',
    parameters: {
      x: { type: 'integer', required: true, description: 'Left edge of the rectangle, absolute virtual-desktop pixels.' },
      y: { type: 'integer', required: true, description: 'Top edge of the rectangle.' },
      w: { type: 'integer', required: true, description: 'Width of the rectangle in pixels.' },
      h: { type: 'integer', required: true, description: 'Height of the rectangle in pixels.' },
      maxSide: { type: 'integer', description: 'The rectangle is downscaled until its longest edge fits this many pixels before hashing (default 320, minimum 16). Keep it: matching digests must come from the same maxSide.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          digest: { type: 'string', required: true, description: 'The fingerprint; equal digests mean pixel-identical rectangles (at the hashed resolution).' },
          x: { type: 'integer' },
          y: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          maxSide: { type: 'integer' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `digest ${value.digest} of the rectangle (${value.x},${value.y}) ${value.width}x${value.height}, hashed at maxSide=${value.maxSide}. The same rectangle at the same maxSide yields the same digest only while those pixels do not change.` },
      ],
    },
    async execute(args, exec) {
      const result = await call(exec, 'digest', {
        region: { x: args.x, y: args.y, width: args.w, height: args.h },
        maxSide: args.maxSide,
      });
      return toLosslessJson(result);
    },
  }));
}
