import { replicateClient } from '@/utils/ReplicateClient';
import { QrGenerateRequest, QrGenerateResponse } from '@/utils/service';
import { NextRequest } from 'next/server';
// import { Ratelimit } from '@upstash/ratelimit';
import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';
import { nanoid } from '@/utils/utils';
import { SpanStatusCode, Span } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { logger, tracer, meter, flushOtel } from '@/otel-server';

// Initialize metrics
const requestCounter = meter.createCounter('qr_generation_requests_total', {
  description: 'Total number of QR code generation requests',
});

const requestDuration = meter.createHistogram('qr_generation_duration_ms', {
  description: 'Duration of QR code generation requests in milliseconds',
});

const modelLatency = meter.createHistogram('replicate_model_latency_ms', {
  description: 'Latency of Replicate AI model calls in milliseconds',
});

/**
 * Validates a request object.
 *
 * @param {QrGenerateRequest} request - The request object to be validated.
 * @throws {Error} Error message if URL or prompt is missing.
 */

const validateRequest = (request: QrGenerateRequest) => {
  if (!request.url) {
    throw new Error('URL is required');
  }
  if (!request.prompt) {
    throw new Error('Prompt is required');
  }
};

// const ratelimit = new Ratelimit({
//   redis: kv,
//   // Allow 20 requests from the same IP in 1 day.
//   limiter: Ratelimit.slidingWindow(20, '1 d'),
// });

export async function POST(request: NextRequest) {
  const requestStartTime = performance.now();

  return tracer.startActiveSpan('qr_generation_request', async (span: Span) => {
    try {
      const reqBody = (await request.json()) as QrGenerateRequest;

      // Set span attributes
      span.setAttributes({
        'http.method': 'POST',
        'http.route': '/api/generate',
        'qr.url': reqBody.url,
        'qr.prompt': reqBody.prompt,
        'qr.prompt_length': reqBody.prompt?.length || 0,
      });

      logger.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: 'QR generation request received',
        attributes: {
          url: reqBody.url,
          prompt: reqBody.prompt,
          prompt_length: reqBody.prompt?.length || 0,
        },
      });

      // const ip = request.ip ?? '127.0.0.1';
      // const { success } = await ratelimit.limit(ip);

      // if (!success && process.env.NODE_ENV !== 'development') {
      //   return new Response('Too many requests. Please try again after 24h.', {
      //     status: 429,
      //   });
      // }

      try {
        validateRequest(reqBody);
      } catch (e) {
        if (e instanceof Error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
          span.recordException(e);

          logger.emit({
            severityNumber: SeverityNumber.ERROR,
            severityText: 'ERROR',
            body: 'Request validation failed',
            attributes: { error: e.message },
          });

          requestCounter.add(1, { status: 'validation_error' });
          return new Response(e.message, { status: 400 });
        }
      }

      const id = nanoid();
      const startTime = performance.now();

      span.setAttributes({ 'qr.id': id });

      logger.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: 'Starting QR code generation',
        attributes: { qr_id: id },
      });

      let imageUrl = await tracer.startActiveSpan(
        'replicate_ai_model_call',
        async (modelSpan: Span) => {
          try {
            modelSpan.setAttributes({
              'ai.model.name': 'qr_code_controlnet',
              'ai.model.provider': 'replicate',
              'qr.conditioning_scale': 2,
              'qr.inference_steps': 30,
              'qr.guidance_scale': 5,
            });

            const result = await replicateClient.generateQrCode({
              url: reqBody.url,
              prompt: reqBody.prompt,
              qr_conditioning_scale: 2,
              num_inference_steps: 30,
              guidance_scale: 5,
              negative_prompt:
                'Longbody, lowres, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, blurry',
            });

            modelSpan.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            modelSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: (error as Error).message,
            });
            modelSpan.recordException(error as Error);
            throw error;
          } finally {
            modelSpan.end();
          }
        },
      );

      const endTime = performance.now();
      const durationMS = endTime - startTime;

      // Record model latency metric
      modelLatency.record(Math.round(durationMS), {
        model: 'qr_code_controlnet',
        provider: 'replicate',
      });

      logger.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: 'AI model generation completed',
        attributes: {
          qr_id: id,
          model_latency_ms: Math.round(durationMS),
        },
      });

      // convert output to a blob object
      const file = await tracer.startActiveSpan(
        'fetch_generated_image',
        async (fetchSpan: Span) => {
          try {
            fetchSpan.setAttributes({ 'http.url': imageUrl });
            const result = await fetch(imageUrl).then((res) => res.blob());
            fetchSpan.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            fetchSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: (error as Error).message,
            });
            fetchSpan.recordException(error as Error);
            throw error;
          } finally {
            fetchSpan.end();
          }
        },
      );

      // upload & store in Vercel Blob
      const { url } = await tracer.startActiveSpan(
        'vercel_blob_upload',
        async (blobSpan: Span) => {
          try {
            blobSpan.setAttributes({
              'blob.filename': `${id}.png`,
              'blob.access': 'public',
            });
            const result = await put(`${id}.png`, file, { access: 'public' });
            blobSpan.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            blobSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: (error as Error).message,
            });
            blobSpan.recordException(error as Error);
            throw error;
          } finally {
            blobSpan.end();
          }
        },
      );

      await tracer.startActiveSpan('vercel_kv_store', async (kvSpan: Span) => {
        try {
          kvSpan.setAttributes({
            'kv.key': id,
            'kv.operation': 'hset',
          });
          await kv.hset(id, {
            prompt: reqBody.prompt,
            image: url,
            website_url: reqBody.url,
            model_latency: Math.round(durationMS),
          });
          kvSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          kvSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          kvSpan.recordException(error as Error);
          throw error;
        } finally {
          kvSpan.end();
        }
      });

      const requestEndTime = performance.now();
      const totalRequestDuration = requestEndTime - requestStartTime;

      // Record metrics
      requestCounter.add(1, { status: 'success' });
      requestDuration.record(Math.round(totalRequestDuration), {
        status: 'success',
      });

      const response: QrGenerateResponse = {
        image_url: url,
        model_latency_ms: Math.round(durationMS),
        id: id,
      };

      span.setAttributes({
        'qr.final_image_url': url,
        'qr.total_duration_ms': Math.round(totalRequestDuration),
      });

      span.setStatus({ code: SpanStatusCode.OK });

      logger.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: 'QR generation request completed successfully',
        attributes: {
          qr_id: id,
          total_duration_ms: Math.round(totalRequestDuration),
          model_latency_ms: Math.round(durationMS),
          final_image_url: url,
        },
      });

      return new Response(JSON.stringify(response), {
        status: 200,
      });
    } catch (error) {
      const requestEndTime = performance.now();
      const totalRequestDuration = requestEndTime - requestStartTime;

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error).message,
      });
      span.recordException(error as Error);

      logger.emit({
        severityNumber: SeverityNumber.ERROR,
        severityText: 'ERROR',
        body: 'QR generation request failed',
        attributes: {
          error: (error as Error).message,
          total_duration_ms: Math.round(totalRequestDuration),
        },
      });

      requestCounter.add(1, { status: 'error' });
      requestDuration.record(Math.round(totalRequestDuration), {
        status: 'error',
      });

      return new Response('Internal Server Error', { status: 500 });
    } finally {
      await flushOtel();
      span.end();
    }
  });
}
