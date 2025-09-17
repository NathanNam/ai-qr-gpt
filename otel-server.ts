import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { trace, metrics } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

// Configuration
const serviceName = 'qr-gpt'; // QR GPT service name

const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
const otlpEndpointBearerToken = process.env.OTEL_EXPORTER_OTLP_BEARER_TOKEN;

const authHeader = otlpEndpointBearerToken
  ? { Authorization: `Bearer ${otlpEndpointBearerToken}` }
  : null;

// Create resource
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
});

// Initialize OpenTelemetry SDK
export const sdk = new NodeSDK({
  resource: resource,
  traceExporter: new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
    headers: {
      ...authHeader,
      'x-observe-target-package': 'Tracing',
    },
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${otlpEndpoint}/v1/metrics`,
      headers: {
        ...authHeader,
        'x-observe-target-package': 'Metrics',
        'Content-Type': 'application/x-protobuf',
      },
    }),
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

// Initialize Logger Provider
const loggerProvider = new LoggerProvider({
  resource: resource,
  processors: [
    new BatchLogRecordProcessor(
      new OTLPLogExporter({
        url: `${otlpEndpoint}/v1/logs`,
        headers: {
          ...authHeader,
          'x-observe-target-package': 'Logs',
        },
      }),
    ),
  ],
});

// Export logger, tracer, and meter for use in application code
export const logger = logs.getLogger(serviceName);
export const tracer = trace.getTracer(serviceName);
export const meter = metrics.getMeter(serviceName);

// Initialize OpenTelemetry and return initialized components
export function initOtel() {
  try {
    logs.setGlobalLoggerProvider(loggerProvider);
    sdk.start();

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'OpenTelemetry SDK started for QR GPT service',
    });
  } catch (error) {
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error starting OpenTelemetry SDK',
      attributes: { error: (error as Error).message },
    });
    throw error;
  }
}

// Graceful shutdown
export function shutdownOtel(): void {
  try {
    sdk.shutdown();
  } catch (error) {
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error shutting down OpenTelemetry SDK',
      attributes: { error: (error as Error).message },
    });
    throw error;
  }
}
