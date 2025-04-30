import { fromPuppeteerDetails, PuppeteerBlocker } from '@cliqz/adblocker-puppeteer';
import { Page } from 'puppeteer';
import { TrackingRequestEvent } from '../types';

/**
 * @fileoverview
 * @see https://github.com/EU-EDPS/website-evidence-collector/blob/f75ef3ea7ff1be24940c4c33218c900afcf31979/lib/setup-beacon-recording.js
 */

const blockerOptions = {
    debug: true, // Keep track of the rule that matched a request
    enableOptimizations: false, // Required to return all information about block rule
    loadCosmeticFilters: false // We're only interested in network filters
};

let blockers: Record<string, PuppeteerBlocker> | null = null;
let blockersInitPromise: Promise<Record<string, PuppeteerBlocker>> | null = null;

const initializeBlockers = async (): Promise<Record<string, PuppeteerBlocker>> => {
    if (blockersInitPromise) {
        return blockersInitPromise;
    }

    blockersInitPromise = (async () => {
        const fetchBlocklist = async (url: string) => {
            const response = await fetch(url);
            return response.text();
        };

        const result = {
            'easyprivacy.txt': await PuppeteerBlocker.parse(
                await fetchBlocklist('https://easylist.to/easylist/easyprivacy.txt'),
                blockerOptions
            ),
            'easylist.txt': await PuppeteerBlocker.parse(
                await fetchBlocklist('https://easylist.to/easylist/easylist.txt'),
                blockerOptions
            )
        };

        blockers = result;
        return result;
    })();

    return blockersInitPromise;
};

// Start initializing blockers when the module is loaded
initializeBlockers().catch(err => console.error('Failed to initialize blockers:', err));

export const setUpThirdPartyTrackersInspector = async (
    page: Page,
    eventDataHandler: (event: TrackingRequestEvent) => void,
    enableAdBlock = false
) => {
    // Ensure blockers are initialized before proceeding
    const loadedBlockers = blockers || await initializeBlockers();
    
    if (enableAdBlock) {
        await page.setRequestInterception(true);
    }

    page.on('request', async request => {
        let isBlocked = false;

        for (const [listName, blocker] of Object.entries(loadedBlockers)) {
            const { match, filter } = blocker.match(fromPuppeteerDetails(request));

            if (!match) {
                continue;
            }

            isBlocked = true;

            const params = new URL(request.url()).searchParams;
            const query = {};
            for (const [key, value] of params.entries()) {
                try {
                    query[key] = JSON.parse(value);
                } catch {
                    query[key] = value;
                }
            }

            eventDataHandler({
                data: {
                    query,
                    filter: filter.toString(),
                    listName
                },
                stack: [
                    {
                        fileName: request.frame()?.url() ?? '',
                        source: 'ThirdPartyTracker RequestHandler'
                    }
                ],
                type: 'TrackingRequest',
                url: request.url()
            });

            break;
        }

        if (enableAdBlock) {
            if (isBlocked) {
                request.abort();
            } else {
                request.continue();
            }
        }
    });
};
