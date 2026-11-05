import * as React from 'react';

import { useConfig } from '@/hooks/use-config';
import { formatPageTitle, resolveSiteTitle } from '@/lib/site';

/** Keep browser tab title in sync with admin「社区标题」. */
export function useDocumentTitle(pageLabel?: string | null) {
	const { config } = useConfig();
	React.useEffect(() => {
		document.title = formatPageTitle(resolveSiteTitle(config), pageLabel);
	}, [config, pageLabel]);
}
