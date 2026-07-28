import { createFilesSpanExporterFromRuntimeEnv } from '@agentpond/files-sdk/otel';
import { LangChainInstrumentation } from '@arizeai/openinference-instrumentation-langchain';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import * as CallbackManagerModule from '@langchain/core/callbacks/manager';

let tracerProvider: NodeTracerProvider | undefined;
let shutdownPromise: Promise<void> | undefined;

if (process.env.FILES_SDK_PROVIDER) {
    tracerProvider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            'service.name': 'pomeloclaw',
        }),
        spanProcessors: [
            new BatchSpanProcessor(createFilesSpanExporterFromRuntimeEnv()),
        ],
    });
    tracerProvider.register();

    const instrumentation = new LangChainInstrumentation({ tracerProvider });
    instrumentation.manuallyInstrument(CallbackManagerModule);

    process.once('beforeExit', () => {
        void shutdownAgentPondTracing();
    });
}

export function shutdownAgentPondTracing(): Promise<void> {
    if (!tracerProvider) return Promise.resolve();
    shutdownPromise ??= tracerProvider.shutdown();
    return shutdownPromise;
}
