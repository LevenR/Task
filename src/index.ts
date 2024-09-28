import { ethers, JsonRpcProvider } from 'ethers';
import dotenv from 'dotenv';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import express from 'express';

dotenv.config();

if (!process.env.B2_STAKE_HUB_CONTRACT || !process.env.RPC_URL || !process.env.B2_STBTC_BRIDGE_CONTRACT) {
    console.error('Missing required environment variables.');
    process.exit(1);
}

const B2_STAKE_HUB_CONTRACT = process.env.B2_STAKE_HUB_CONTRACT!;
const B2_STBTC_BRIDGE_CONTRACT = process.env.B2_STBTC_BRIDGE_CONTRACT!;
const RPC_URL = process.env.RPC_URL!;
const START_TRACK_TIME = process.env.START_TRACK_TIME!;
const END_TRACK_TIME = process.env.END_TRACK_TIME!;

const BLOCK_FILE = 'last_processed_block.txt'; //record last process bolck number
const POLLING_INTERVAL = 5000; // 5 seconds

const B2_STAKE_HUB_ABI = [
  "event StakeBTC2JoinStakePlan(uint256 indexed stakeIndex, uint256 indexed planId, address indexed user, address btcContractAddress, uint256 stakeAmount, uint256 stBTCAmount)"
];

const B2_STBTC_BRIDGE_ABI = [
    "event Burn(address from, uint256 amount, uint256 fromChainId, uint256 toChainId, address fromStBtcAddress, address toStBtcAddress, address receiver)"
];

console.log('SUPABASE_URL:', process.env.SUPABASE_URL!);
console.log('SUPABASE_KEY:', process.env.SUPABASE_KEY!);

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_KEY!
);

const provider = new ethers.JsonRpcProvider(RPC_URL);
const app = express();
const port = 3000;
  
async function getLastProcessedBlock(): Promise<number> {
    try {
      const blockNumber = await fs.promises.readFile(BLOCK_FILE, 'utf8');
      return parseInt(blockNumber.trim(), 10);
    } catch (error) {
      return 0; // Start from block 0 if file doesn't exist
    }
}

async function processEvents(
    b2_stake_hub_contract: ethers.Contract,
    b2_stBTC_bridge_contract: ethers.Contract,
    fromBlock: number,
    toBlock: number
) {
    console.log(`Processing events from block ${fromBlock} to ${toBlock}`);
    const stakingFilter = b2_stake_hub_contract.filters.StakeBTC2JoinStakePlan();
    const stakingEvents = await b2_stake_hub_contract.queryFilter(stakingFilter, fromBlock, toBlock);

    const burnFilter = b2_stBTC_bridge_contract.filters.Burn();
    const burnEvents = await b2_stBTC_bridge_contract.queryFilter(burnFilter, fromBlock, toBlock);
  
    for (const event of stakingEvents) {
      if (event instanceof ethers.EventLog) {
        const { args } = event;
        if (args && args.length >= 6) {
            const [stakeIndex, planId, user, btcContractAddress, stakeAmount, stBTCAmount] = args;
            const block = await provider.getBlock(event.blockNumber);
            const timestamp = block?.timestamp!;

            console.log(
                `StakeBTC2JoinStakePlan detected:
                        stakeIndex: ${stakeIndex}, 
                        planId: ${planId}, 
                        user: ${user}, 
                        btcContractAddress: ${btcContractAddress}, 
                        stakeAmount: ${stakeAmount}, 
                        stBTCAmount: ${stBTCAmount}
                        timestamp: ${timestamp}`
            );
            const user_addr = user.toLowerCase();
            
            if (stBTCAmount >= ethers.parseEther("0.0001")) {
                const { error } = await supabase
                    .from('b2_test_tasks')
                    .insert([
                        { user_addr: user_addr, task: "mint", complete_at:  new Date(timestamp * 1000).toISOString()}
                    ])
                
                if (error != null) {
                    console.log('insert error, code: ', error.code, ' message: ', error.message)
                }
            }else{
                console.log('stBTCAmount is less than 0.0002');
            }
        }
      }
    }

    for (const event of burnEvents) {
        if (event instanceof ethers.EventLog) {
            const { args } = event;
            if (args && args.length >= 7) {
                const [from, amount, fromChainId, toChainId, fromStBtcAddress, toStBtcAddress, receiver] = args;
                const block = await provider.getBlock(event.blockNumber);
                const timestamp = block?.timestamp!;

                console.log(
                    `Burn detected:
                            from: ${from}, 
                            amount: ${amount}, 
                            fromChainId: ${fromChainId}, 
                            toChainId: ${toChainId}, 
                            fromStBtcAddress: ${fromStBtcAddress}, 
                            toStBtcAddress: ${toStBtcAddress},
                            receiver: ${receiver}`
                );
                const user_addr = from.toLowerCase();
                if ( amount >= ethers.parseEther("0.0001")) {
                    const { error } = await supabase
                        .from('b2_test_tasks')
                        .insert([
                            { user_addr: user_addr, task: "bridge", complete_at:  new Date(timestamp * 1000).toISOString()}
                        ])
                
                    if (error != null) {
                        console.log('insert error, code: ', error.code, ' message: ', error.message)
                    }
                } else {
                    console.log('swap stBTCAmount is less than 0.0002');
                }
            }
        }
    }
}

async function saveLastProcessedBlock(blockNumber: number): Promise<void> {
    await fs.promises.writeFile(BLOCK_FILE, blockNumber.toString());
}

async function getBlockHeightByTimestamp(provider: JsonRpcProvider, startBlock: number, timestamp: number) {
    let from = startBlock;
    let to = Number(await provider.getBlockNumber());

    while (from < to) {
        const mid = Math.floor((from + to) / 2);
        const block = await provider.getBlock(mid);
        if (block!.timestamp < timestamp) {
            from = mid + 1;
        } else {
            to = mid;
        }
    }
    return from;
}

async function main() {
    const b2_stake_hub_contract = new ethers.Contract(B2_STAKE_HUB_CONTRACT, B2_STAKE_HUB_ABI, provider);
    const b2_stBTC_bridge_contract = new ethers.Contract(B2_STBTC_BRIDGE_CONTRACT, B2_STBTC_BRIDGE_ABI, provider);
  
    let lastProcessedBlock = await getLastProcessedBlock();
    console.log(`Starting to process events from block ${lastProcessedBlock}`);
    let bStartTrack = false;
    let finished = false;
  
    while (true) {

        if (finished) {
            console.log(`Track event already finished...`);
            return;
        }

        const latestBlock = await provider.getBlockNumber();
        console.log('latestBlock:', latestBlock);
        if (!bStartTrack) {
            const block = await provider.getBlock(latestBlock);
            console.log("latestBlock.timestamp: ", block!.timestamp)
            const block1 = await provider.getBlock(lastProcessedBlock);
            console.log("lastProcessedBlock.timestamp: ", block1!.timestamp)

            if (block1!.timestamp > Number(END_TRACK_TIME)) {
                console.log("4YA_BNB_Task already finish!!!")
                return;
            }

            if (block1!.timestamp > Number(START_TRACK_TIME)) {
                bStartTrack = true
            }
            if (block1!.timestamp < Number(START_TRACK_TIME) && block!.timestamp > Number(START_TRACK_TIME)) { 
                bStartTrack = true
                let startBlock = await getBlockHeightByTimestamp(provider, lastProcessedBlock, Number(START_TRACK_TIME));
                if (startBlock > lastProcessedBlock) {
                    lastProcessedBlock = startBlock - 1;
                }
            }
            console.log('lastProcessedBlock: ', lastProcessedBlock);
        }
        if (bStartTrack) {
            try {
                if (latestBlock > lastProcessedBlock) {
                    let fromBlock = lastProcessedBlock + 1;
                    let toBlock = Math.min(latestBlock, fromBlock + 499); // Process max 100 blocks at a time

                    const block = await provider.getBlock(toBlock);
                    if (block!.timestamp > Number(END_TRACK_TIME)) {
                        let endBlock = await getBlockHeightByTimestamp(provider, fromBlock, Number(END_TRACK_TIME));
                        toBlock = endBlock
                        finished = true
                    }
                    if(fromBlock > toBlock){
                        return;
                    }
                        
                    await processEvents(b2_stake_hub_contract, b2_stBTC_bridge_contract, fromBlock, toBlock);
                        
                    lastProcessedBlock = toBlock;
                    await saveLastProcessedBlock(lastProcessedBlock);
                }
            } catch (error) {
                console.error('Error processing events:', error);
            }
        } else {
            console.log(`Start Time not reach. ${START_TRACK_TIME}`);
        }
    
        // Wait before next polling
        console.log(`==================================`);
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
    }
}
  
app.get('/', async (req, res) => {

    const { address, date, task } = req.query;
    if (!address || !date || !task) {
        res.status(400).json({ error: 'Missing required parameters' });
        return;
    }
    const user_addr = address.toString().toLowerCase();
    console.log('user_addr:', user_addr);
    console.log('date:', date);
    console.log('task:', task);

    try {
        const { data, error } = await supabase
          .from('b2_test_tasks')
          .select('*')
          .eq('user_addr', user_addr)
          .eq('task', task)
          .gte('complete_at', `${date}T00:00:00Z`)
          .lt('complete_at', `${date}T23:59:59Z`);
    
        if (error) throw error;
        if (data.length > 0) {
            res.status(200).json({ code: 0, data: true });
        } else {
            res.status(200).json({ code: 0, data: false });
        }
      } catch (error) {
        console.error('Error querying database:', error);
        res.status(500).json({ code: 0, data: false });
    }

});

// main().catch((error) => {
//     console.error(error);
//     process.exit(1);
// });
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    main();
    //testDatabaseConnection();
    // testDatabaseConnection().then(() => {
    //     main().catch((error) => {
    //         console.error('Error in main function:', error);
    //         process.exit(1);
    //     });
    // });
});
  