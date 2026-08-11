// C++ side of the parity test: fold the shared fixtures with the ACTUAL desktop
// engine (../../src/scala_engine.hpp) and print the folded calendar as JSON on
// stdout. Compared against the JS engine's fold of the same fixtures.
//   g++ -std=c++17 -I<nlohmann_include> fold_cpp.cpp -o fold_cpp && ./fold_cpp < fixtures.json
#include "../../src/scala_engine.hpp"
#include <iostream>
#include <sstream>

int main() {
    std::stringstream ss;
    ss << std::cin.rdbuf();
    scala::json in = scala::json::parse(ss.str());
    std::string calId = in.value("calId", std::string("cal1"));
    std::vector<scala::Event> log;
    for (auto& j : in["log"]) log.push_back(scala::eventFromJson(j));
    scala::json folded = scala::foldCalendar(calId, log);
    std::cout << folded.dump() << std::endl;
    return 0;
}
