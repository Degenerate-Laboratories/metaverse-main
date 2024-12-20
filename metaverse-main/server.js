import React, { useEffect, useState } from 'react';
import { SDK } from '@coinmasters/pioneer-sdk';
import { getPaths } from '@pioneer-platform/pioneer-coins';
import {
	Box,
	Input,
	Center,
	VStack,
	Spinner,
	Text,
	Heading,
	Divider,
	Link
} from '@chakra-ui/react';

const TAG = " | Welcome | "

let setup = {
	appName: 'KeepKey',
	appIcon: 'https://pioneers.dev/keepkey.png',
}

export const TOOLS = [];

export default function Welcome({ isDesktopRunning, isBrowserExtensionInstalled }) {
	const [loading, setLoading] = useState(true);
	const [welcomeMessage, setWelcomeMessage] = useState("");

	const onStart = async (wallets: any, setup: any) => {
		let tag = TAG + ' | onStart | ';
		try {
			if (!setup.appName || !setup.appIcon) throw Error('App name and icon are required!');
			const username = localStorage.getItem('username') || `user:${crypto.randomUUID()}`.substring(0, 13);
			localStorage.setItem('username', username);

			const queryKey = localStorage.getItem('queryKey') || `key:${crypto.randomUUID()}`;
			localStorage.setItem('queryKey', queryKey);

			let keepkeyApiKey = localStorage.getItem('keepkeyApiKey');
			console.log(tag, '(from localstorage) keepkeyApiKey: ', keepkeyApiKey);
			if (!keepkeyApiKey) keepkeyApiKey = '01d97532-d0f0-4c5e-8afd-072741bc24ca';

			let blockchains = []
			const paths = getPaths(blockchains);
			const spec = localStorage.getItem('pioneerUrl') || 'https://pioneers.dev/spec/swagger.json';
			const wss = 'wss://pioneers.dev';

			//@ts-ignore
			const appInit = new SDK(spec, {
				spec,
				wss,
				appName: setup.appName,
				appIcon: setup.appIcon,
				blockchains,
				keepkeyApiKey,
				username,
				queryKey,
				paths,
			});

			const api = await appInit.init([], setup);
			console.log(tag, 'api: ', api);

			blockchains = appInit.blockchains
			console.log(tag, 'blockchains: ', blockchains);

			let balances = appInit.balances;
			console.log(tag, 'balances: ', balances);

			let pubkeys = appInit.pubkeys;
			console.log(tag, 'pubkeys: ', pubkeys);

			let messages = [
				{
					role: 'system',
					content: `You are KeepKey, and welcoming users. You build the welcome screen.`,
				},
				{
					role: 'system',
					content: `Summarize all the user input and create a welcome that shows you are aware of all the user's data and provide a uniquely amazing experience.`,
				},
				{
					role: 'user',
					content: [
						`blockchains: ` + JSON.stringify(blockchains),
						`pubkeys: ` + JSON.stringify(pubkeys),
						`balances: ` + JSON.stringify(balances),
					].join('\n'),
				},
			]

			let welcomeScreen = await api.Inference({
				messages,
				functions: TOOLS,
			});
			console.log('welcomeScreen: ', welcomeScreen)

			// Handle the response carefully:
			// The structure you showed resembles:
			// {
			//   data: {
			//     success: boolean,
			//     result: {
			//       choices: [
			//         {
			//           message: {
			//             content: string
			//           }
			//         }
			//       ]
			//     }
			//   }
			// }

			let success = welcomeScreen?.data?.success;
			let content = welcomeScreen?.data?.result?.choices?.[0]?.message?.content;

			if (success && content) {
				setWelcomeMessage(content);
			} else if (!success) {
				setWelcomeMessage("The AI request was not successful. Please try again.");
			} else {
				setWelcomeMessage("No welcome message was received from the AI.");
			}

		} catch (e) {
			console.error('Failed to start app!', e);
			setWelcomeMessage("An error occurred while fetching the welcome message.");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		(async () => {
			await onStart([], setup);
		})();
	}, []);

	return (
		<Box w="100%" minH="100vh" p={8}>
			<Center mt={10} flexDirection="column" w="100%">
				<Box mb={8} w={{ base: '90%', md: '50%' }}>
					<Input placeholder="Search Dapps, Wallets, or Transactions..." size="lg" />
				</Box>

				{loading ? (
					<Spinner size="xl" />
				) : (
					<VStack spacing={4}>
						<Text fontSize="lg" fontWeight="bold">
							{welcomeMessage}
						</Text>
					</VStack>
				)}

				{isBrowserExtensionInstalled ? (
					<VStack spacing={6} w="100%">
						<Heading size="md">Browser Extension found!</Heading>
					</VStack>
				) : (
					<VStack spacing={4}>
						<Text fontSize="lg" fontWeight="bold">No Browser Extension Detected</Text>
						<Text fontSize="sm" color="gray.500">
							To view recent Dapps and more features, please install our browser extension.
						</Text>
						<Link href="#" color="blue.500" fontWeight="bold">
							Install Browser Extension
						</Link>
					</VStack>
				)}

				<Divider my={10} />
			</Center>
		</Box>
	);
}
