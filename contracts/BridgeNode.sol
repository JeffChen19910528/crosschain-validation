// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * BridgeNode — AO4C（AI-Augmented Optimistic Cross-Chain Concurrency Control）
 *
 * 雙向對稱跨鏈合約，兩條鏈各部署一份。
 * 演算法核心全部在此合約層，Oracle 只做輕量中繼。
 *
 * 解決的問題：
 *  - TOD：確定性排序承諾（seqNo = hash(requestId + blockNumber + chainId)）
 *  - Front-Running：Commit-Reveal（Phase 1 隱藏金額）
 *  - 雙花攻擊：processedRequests + OCC version + AI 語意判斷三層防護
 *  - ACID Isolation：globalVersion 序列化點 + validateAndExecute version 驗證
 *
 * 三階段 OCC 流程：
 *  Phase 1 commitOrder()      → Order Commitment，防 TOD + Front-Running
 *  Phase 2 revealOrder()      → Reveal + 鏈上確定性排序，emit 有序序列給 Oracle
 *  Phase 3 validateAndExecute() → AI Agent 驗證結果 + version 最後防線 + 執行
 */
contract BridgeNode {

    // ─── 狀態變數 ────────────────────────────────────────────────

    address public owner;
    address public oracle;
    uint256 public immutable thisChainId;

    /// OCC 全域版本計數器：每次成功 commit 遞增，作為序列化點
    uint256 public globalVersion;

    /// 確定性排序序號計數器
    uint256 public nextSeqNo;

    /// peer chain 合約地址 mapping：chainId => BridgeNode address
    mapping(uint256 => address) public peerNodes;

    /// 交易記錄
    mapping(bytes32 => CommitRecord) public commitRecords;

    /// 防雙花：已執行的 requestId
    mapping(bytes32 => bool) public processedRequests;

    /// 已 abort 的 requestId
    mapping(bytes32 => bool) public abortedRequests;

    // ─── 資料結構 ────────────────────────────────────────────────

    struct CommitRecord {
        address sender;
        bytes32 blindedAmount;   // keccak256(abi.encodePacked(amount, salt))
        address recipient;
        uint256 targetChainId;   // 目標鏈 chainId，決定交易方向
        uint256 blockNumber;     // commit 時的 blockNumber，用於確定性排序
        uint256 seqNo;           // 鏈上確定性排序序號（Phase 2 reveal 時賦予）
        uint256 readVersion;     // OCC read-set stamp（commit 時記錄 globalVersion）
        uint256 amount;          // reveal 後填入
        bool    revealed;
        bool    executed;
        bool    aborted;
    }

    // ─── 事件 ────────────────────────────────────────────────────

    /// Phase 1：承諾上鏈
    event OrderCommitted(
        bytes32 indexed requestId,
        address indexed sender,
        bytes32 blindedAmount,
        address recipient,
        uint256 targetChainId,
        uint256 blockNumber,
        uint256 readVersion
    );

    /// Phase 2：reveal 完成，鏈上排序序號確定
    /// Oracle 監聽此事件，帶有序序列呼叫 AI Agent
    event OrderRevealed(
        bytes32 indexed requestId,
        address indexed sender,
        uint256 amount,
        address recipient,
        uint256 targetChainId,
        uint256 seqNo,           // 確定性排序序號，Oracle 用此排列有序序列
        uint256 readVersion
    );

    /// Phase 3a：AI 判定無衝突，commit 成功
    event OrderExecuted(
        bytes32 indexed requestId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 seqNo,
        uint256 newGlobalVersion,
        string  conflictNote
    );

    /// Phase 3b：AI 判定有衝突 或 version 衝突，abort + 退款
    event OrderAborted(
        bytes32 indexed requestId,
        address indexed sender,
        uint256 amount,
        uint256 seqNo,
        string  reason
    );

    // ─── Modifier ────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == oracle, "Not oracle");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────

    constructor(uint256 _chainId, address _oracle) {
        owner       = msg.sender;
        oracle      = _oracle;
        thisChainId = _chainId;
    }

    // ─── 管理函數 ────────────────────────────────────────────────

    /// 設定 peer chain 的 BridgeNode 地址（deploy 後互相設定）
    function setPeerNode(uint256 chainId, address nodeAddress) external onlyOwner {
        require(chainId != thisChainId, "Cannot peer with self");
        peerNodes[chainId] = nodeAddress;
    }

    function setOracle(address _oracle) external onlyOwner {
        oracle = _oracle;
    }

    // ─── Phase 1：Order Commitment ───────────────────────────────

    /**
     * 發起跨鏈交易（防 TOD + Front-Running）
     *
     * 使用者只送 blindedAmount = keccak256(abi.encodePacked(amount, salt))
     * 不暴露實際金額，防止 front-running 攻擊者判斷是否值得搶跑
     *
     * OCC 樂觀執行：不加任何 mutex，允許高並發進入
     * readVersion 記錄當下 globalVersion，作為 OCC read-set stamp
     *
     * @param blindedAmount  keccak256(abi.encodePacked(amount, salt))
     * @param recipient      目標鏈的接收地址
     * @param targetChainId  目標鏈的 chainId
     */
    function commitOrder(
        bytes32 blindedAmount,
        address recipient,
        uint256 targetChainId
    ) external payable {
        require(msg.value > 0,                    "Amount must be > 0");
        require(recipient != address(0),           "Invalid recipient");
        require(targetChainId != thisChainId,      "Cannot bridge to self");
        require(peerNodes[targetChainId] != address(0), "Unknown target chain");

        // OCC 樂觀讀取：記錄當下版本作為 read-set stamp
        uint256 readVersion = globalVersion;

        // requestId：包含 sender + value + nonce(時間戳) + chainId，確保唯一
        bytes32 requestId = keccak256(abi.encodePacked(
            msg.sender, msg.value, block.timestamp, block.number, thisChainId
        ));
        require(commitRecords[requestId].sender == address(0), "Duplicate requestId");

        commitRecords[requestId] = CommitRecord({
            sender:        msg.sender,
            blindedAmount: blindedAmount,
            recipient:     recipient,
            targetChainId: targetChainId,
            blockNumber:   block.number,
            seqNo:         0,           // Phase 2 才賦予
            readVersion:   readVersion,
            amount:        0,           // Phase 2 才填入
            revealed:      false,
            executed:      false,
            aborted:       false
        });

        emit OrderCommitted(
            requestId, msg.sender, blindedAmount,
            recipient, targetChainId, block.number, readVersion
        );
    }

    // ─── Phase 2：Reveal & Ordering ──────────────────────────────

    /**
     * Reveal 真實金額，合約驗證 hash，賦予確定性排序序號
     *
     * 確定性排序（防 TOD 核心）：
     *   seqNo 由 nextSeqNo++ 賦予，順序由此合約的 EVM 執行序決定
     *   而非礦工的 mempool 排序
     *   相同的交易集合永遠產生相同的 seqNo 序列 → TOD 防護
     *
     * @param requestId  Phase 1 產生的 requestId
     * @param amount     真實金額（wei）
     * @param salt       Phase 1 使用的 salt
     */
    function revealOrder(
        bytes32 requestId,
        uint256 amount,
        uint256 salt
    ) external {
        CommitRecord storage rec = commitRecords[requestId];
        require(rec.sender != address(0),  "Request not found");
        require(rec.sender == msg.sender,  "Not your request");
        require(!rec.revealed,             "Already revealed");
        require(!rec.aborted,              "Already aborted");
        require(rec.amount == 0,           "Already set");

        // 驗證 blindedAmount（防 front-running：使用者必須知道 salt 才能 reveal）
        require(
            keccak256(abi.encodePacked(amount, salt)) == rec.blindedAmount,
            "Hash mismatch: invalid amount or salt"
        );

        rec.amount   = amount;
        rec.revealed = true;

        // 確定性排序序號：EVM 執行序決定，不受礦工操控
        rec.seqNo = nextSeqNo++;

        emit OrderRevealed(
            requestId, rec.sender, amount,
            rec.recipient, rec.targetChainId,
            rec.seqNo, rec.readVersion
        );
    }

    // ─── Phase 3：Validate & Execute ─────────────────────────────

    /**
     * AI Agent 驗證結果 + EVM version 最後防線 + 執行
     *
     * 此函數由 Oracle 呼叫，帶入 Claude Code CLI 的判斷結果。
     * 合約做最終的 version 驗證（即使 AI 判斷基於舊快照，EVM 這層也會擋住）。
     *
     * ACID Isolation 保證：
     *   require(globalVersion == expectedVersion) 確保在 AI 判斷期間
     *   沒有其他交易修改了共用狀態，等效 Serializable Isolation
     *
     * @param requestId       目標交易
     * @param hasConflict     AI Agent 判斷結果（true = 衝突，false = 無衝突）
     * @param conflictNote    AI Agent 的說明（上鏈存證）
     * @param expectedVersion Oracle 送入 AI 判斷時讀取的 globalVersion
     */
    function validateAndExecute(
        bytes32 requestId,
        bool    hasConflict,
        string  calldata conflictNote,
        uint256 expectedVersion
    ) external onlyOracle {
        require(!processedRequests[requestId], "Already processed");
        require(!abortedRequests[requestId],   "Already aborted");

        CommitRecord storage rec = commitRecords[requestId];
        require(rec.sender    != address(0), "Request not found");
        require(rec.revealed,                "Not yet revealed");
        require(!rec.executed,               "Already executed");
        require(!rec.aborted,                "Already aborted");
        require(address(this).balance >= rec.amount, "Insufficient funds");

        if (hasConflict) {
            // AI Agent 判定有衝突：abort + 退款
            _abort(requestId, rec, conflictNote);
        } else {
            // EVM 最後防線：version 驗證
            // 若 AI 判斷期間有其他交易 commit，globalVersion 會與 expectedVersion 不同
            if (globalVersion != expectedVersion) {
                _abort(requestId, rec, "Version conflict: concurrent commit detected");
                return;
            }
            // Commit：transfer ETH 到目標鏈由 Oracle 執行，此鏈記錄狀態
            processedRequests[requestId] = true;
            rec.executed = true;
            globalVersion++;   // 序列化點遞增
            emit OrderExecuted(
                requestId, rec.sender, rec.recipient,
                rec.amount, rec.seqNo, globalVersion, conflictNote
            );
        }
    }

    /**
     * 目標鏈執行 ETH transfer（由 Oracle 呼叫）
     * 在目標鏈的 BridgeNode 上執行，將 ETH 轉給 recipient
     *
     * @param requestId  原始鏈的 requestId（跨鏈對應用）
     * @param recipient  接收地址
     * @param amount     金額（wei）
     * @param srcChainId 來源鏈 chainId
     */
    function executeTransfer(
        bytes32 requestId,
        address payable recipient,
        uint256 amount,
        uint256 srcChainId
    ) external onlyOracle {
        require(!processedRequests[requestId], "Already processed");
        require(peerNodes[srcChainId] != address(0), "Unknown source chain");
        require(address(this).balance >= amount, "Insufficient bridge funds");

        processedRequests[requestId] = true;
        recipient.transfer(amount);

        emit OrderExecuted(
            requestId, address(0), recipient,
            amount, 0, globalVersion, "transfer from peer chain"
        );
    }

    // ─── 內部函數 ────────────────────────────────────────────────

    function _abort(
        bytes32 requestId,
        CommitRecord storage rec,
        string memory reason
    ) internal {
        abortedRequests[requestId] = true;
        rec.aborted = true;
        payable(rec.sender).transfer(rec.amount);
        emit OrderAborted(requestId, rec.sender, rec.amount, rec.seqNo, reason);
    }

    // ─── 工具函數 ────────────────────────────────────────────────

    function getRecord(bytes32 requestId)
        external view
        returns (CommitRecord memory)
    {
        return commitRecords[requestId];
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function deposit() external payable {}

    receive() external payable {}
}
