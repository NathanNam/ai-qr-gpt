import { getEnv, ENV_KEY } from '@/utils/env';
import Replicate from 'replicate';
import { QrCodeControlNetRequest, QrCodeControlNetResponse } from './types';
import { trace, SpanStatusCode, Span } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { logger, tracer } from '@/otel-server';

export class ReplicateClient {
  replicate: Replicate;

  constructor(apiKey: string) {
    this.replicate = new Replicate({
      auth: apiKey,
    });
  }

  /**
   * Generate a QR code.
   */
  generateQrCode = async (
    request: QrCodeControlNetRequest,
  ): Promise<string> => {
    return tracer.startActiveSpan(
      'replicate_qr_generation',
      async (span: Span) => {
        try {
          const modelId =
            'zylim0702/qr_code_controlnet:628e604e13cf63d8ec58bd4d238474e8986b054bc5e1326e50995fdbc851c557';

          span.setAttributes({
            'ai.model.id': modelId,
            'ai.model.provider': 'replicate',
            'ai.operation': 'qr_code_generation',
            'qr.url': request.url,
            'qr.prompt': request.prompt,
            'qr.conditioning_scale': request.qr_conditioning_scale || 0,
            'qr.inference_steps': request.num_inference_steps || 0,
            'qr.guidance_scale': request.guidance_scale || 0,
          });

          logger.emit({
            severityNumber: SeverityNumber.INFO,
            severityText: 'INFO',
            body: 'Starting Replicate AI model execution',
            attributes: {
              model_id: modelId,
              url: request.url,
              prompt: request.prompt,
              conditioning_scale: request.qr_conditioning_scale,
              inference_steps: request.num_inference_steps,
              guidance_scale: request.guidance_scale,
            },
          });

          const startTime = performance.now();

          const output = (await this.replicate.run(modelId, {
            input: {
              url: request.url,
              prompt: request.prompt,
              qr_conditioning_scale: request.qr_conditioning_scale,
              num_inference_steps: request.num_inference_steps,
              guidance_scale: request.guidance_scale,
              negative_prompt: request.negative_prompt,
            },
          })) as QrCodeControlNetResponse;

          const endTime = performance.now();
          const duration = endTime - startTime;

          if (!output) {
            const error = new Error('Failed to generate QR code');
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            });
            span.recordException(error);

            logger.emit({
              severityNumber: SeverityNumber.ERROR,
              severityText: 'ERROR',
              body: 'Replicate AI model returned no output',
              attributes: {
                model_id: modelId,
                duration_ms: Math.round(duration),
              },
            });

            throw error;
          }

          span.setAttributes({
            'ai.response.output_count': output.length,
            'ai.response.duration_ms': Math.round(duration),
          });

          span.setStatus({ code: SpanStatusCode.OK });

          logger.emit({
            severityNumber: SeverityNumber.INFO,
            severityText: 'INFO',
            body: 'Replicate AI model execution completed successfully',
            attributes: {
              model_id: modelId,
              duration_ms: Math.round(duration),
              output_count: output.length,
            },
          });

          return output[0];
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          span.recordException(error as Error);

          logger.emit({
            severityNumber: SeverityNumber.ERROR,
            severityText: 'ERROR',
            body: 'Replicate AI model execution failed',
            attributes: {
              error: (error as Error).message,
            },
          });

          throw error;
        } finally {
          span.end();
        }
      },
    );
  };
}

const apiKey = getEnv(ENV_KEY.REPLICATE_API_KEY);
if (!apiKey) {
  throw new Error('REPLICATE_API_KEY is not set');
}
export const replicateClient = new ReplicateClient(apiKey);
